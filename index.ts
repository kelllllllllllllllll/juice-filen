import fs from "node:fs/promises";
import NPath from "node:path";
import { type } from "arktype";
import { Sema } from "async-sema";
import { $ } from "bun";
import { Config, type ExtendedFile, type ExtendedFolder } from "./arktype";
import { download_file } from "./streamfile";
import {
	convertPath,
	flatTreeToPathRecordDFS,
	getFlatTree,
	getRemoteMetadata,
	setRemoteMetadata,
} from "./utils";

async function* walk(dir: string): AsyncGenerator<string> {
	for await (const d of await fs.opendir(dir)) {
		const entry = NPath.join(dir, d.name);
		if (d.isDirectory()) yield* walk(entry);
		else if (d.isFile()) yield entry;
	}
}

async function folder_Picker(description: string) {
	if (process.platform !== "win32") {
		throw new Error("Folder picker is only supported on Windows");
	}
	const result =
		await $`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; \$folderBrowserDialog = New-Object System.Windows.Forms.FolderBrowserDialog; \$folderBrowserDialog.Description = '${description}'; \$folderBrowserDialog.ShowNewFolderButton = \$true; \$folderBrowserDialog.RootFolder = [System.Environment+SpecialFolder]::Desktop; \$folderBrowserDialog.AutoUpgradeEnabled = \$true; if (\$folderBrowserDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Host \$folderBrowserDialog.SelectedPath }"`.text();
	if (await fs.exists(result)) {
		const stat = await fs.stat(result);
		if (!stat.isDirectory()) {
			throw new Error("Selected path is not a folder");
		}
		return result;
	}
	throw new Error("Folder picker returned invalid path");
}

function shouldSkipDownload(path: string, config: Config) {
	for (const exclude of config.exclude) {
		if (path.startsWith(exclude)) {
			return true;
		}
	}
	return false;
}

async function moveFileToRemoved(
	filepath: string,
	removedpath: string,
	basepath: string,
) {
	const rel = NPath.relative(basepath, filepath);
	const finalpath = NPath.join(removedpath, rel);
	await fs.mkdir(NPath.dirname(finalpath), { recursive: true });
	await fs.rename(filepath, finalpath);
}

async function download_entry(
	entry: ExtendedFile | ExtendedFolder,
	filepath: string,
	maxChunks: Sema,
): Promise<number> {
	// 0 = downloaded new file, 1 = file already exists and is the same, 2 = file already exists and is different
	if (entry.kind === "file") {
		try {
			const localMetadata = await getRemoteMetadata(filepath);
			if (
				localMetadata.size === entry.metadata.size &&
				localMetadata.lastModified === entry.metadata.lastModified &&
				localMetadata.creation === entry.metadata.creation
			) {
				return 1; // File exists and is the same
			}
		} catch (e) {
			// If getRemoteMetadata throws, it means attributes are not set or file doesn't exist.
			// Proceed to download.
		}
		await fs.mkdir(NPath.dirname(filepath), { recursive: true });

		await download_file(entry, filepath, maxChunks);

		await setRemoteMetadata(filepath, {
			uuid: entry.uuid, // Assuming entry has uuid, if not adjust
			lastModified: entry.metadata.lastModified,
			creation: entry.metadata.creation,
			size: entry.metadata.size,
		});
	}
	if (entry.kind === "folder") {
		await fs.mkdir(filepath, { recursive: true });
		// For folders, we might want to set some default/derived metadata if applicable
		// For now, we're only explicitly setting metadata for files after download.
		// If folders also need persistent metadata via xattr, add setRemoteMetadata here.
	}
	return 0;
}

async function sync(
	PathRecord: Record<string, ExtendedFile | ExtendedFolder>,
	config: Config,
) {
	let count = 0;
	let total = 0;

	const maxChunks = new Sema(config.max_chunks);
	const maxFiles = new Sema(config.max_files);

	const promises: Promise<void>[] = [];
	for (const [path, entry] of Object.entries(PathRecord)) {
		const filePath = NPath.resolve(config.base_directory, ...entry.path);
		process.stdout.write("\x1B[?25l");
		if (shouldSkipDownload(path, config)) {
			continue;
		}

		promises.push(
			maxFiles
				.acquire()
				.then(async () => {
					// Make this async to await download_entry
					const downloadResult = await download_entry(
						entry,
						filePath,
						maxChunks,
					); // Await the result
					// setRemoteMetadata is now called inside download_entry for files
					return downloadResult; // Pass result for further processing if needed
				})
				.then(() => {
					const trimmedname = entry.path[entry.path.length - 1];
					const length_of_total = total.toString().length;
					count++;
					if (entry.kind === "file") {
						process.stdout.write(
							`\r\x1b[2K${count.toString().padStart(length_of_total)}/${total} | ${maxChunks.nrWaiting()} chunks waiting ${maxChunks.nrWaiting() < 64 ? "you should increase max_files " : ""}| Last download was ${trimmedname}`,
						);
					}
				})
				.finally(() => {
					maxFiles.release();
				})
				.catch(async (e) => {
					if (e instanceof Error) {
						console.error(e.message);
					} else {
						console.error(e);
					}
					try {
						await fs.unlink(filePath);
					} catch (e) {}
				}),
		);
	}
	total = promises.length;
	await Promise.all(promises);
	process.stdout.write("\x1B[?25h\r\n");
	await maxFiles.drain();
	await maxChunks.drain();
}

async function verify(
	PathRecord: Record<string, ExtendedFile | ExtendedFolder>,
	config: Config,
) {
	console.log("verifying files");
	const removedwithdate = NPath.join(
		config.removed_directory,
		new Date().toISOString().replaceAll(":", "-"),
	);

	const files_to_move: {
		filepath: string;
		mismatches: {
			type: "size" | "mtime" | "btime" | "notfound" | "metadata_error";
			message: string;
		}[];
	}[] = [];
	let total = 0;
	for await (const filepath of walk(config.base_directory)) {
		total++;
		const rel = convertPath(
			NPath.relative(config.base_directory, filepath),
			"posix",
		);

		const entry_path = rel.startsWith("/") ? rel.trim() : `/${rel}`.trim();

		const entry = PathRecord[entry_path];
		if (entry) {
			if (entry.kind === "file") {
				const mismatches: {
					type: "size" | "mtime" | "btime" | "notfound" | "metadata_error";
					message: string;
				}[] = [];
				try {
					const localMetadata = await getRemoteMetadata(filepath);

					if (localMetadata.size !== entry.metadata.size) {
						mismatches.push({
							type: "size",
							message: `On disk: ${localMetadata.size} !== On cloud: ${entry.metadata.size}`,
						});
					}
					if (localMetadata.lastModified !== entry.metadata.lastModified) {
						mismatches.push({
							type: "mtime",
							message: `On disk: ${localMetadata.lastModified} !== On cloud: ${entry.metadata.lastModified}`,
						});
					}
					if (localMetadata.creation !== entry.metadata.creation) {
						mismatches.push({
							type: "btime",
							message: `On disk: ${localMetadata.creation} !== On cloud: ${entry.metadata.creation}`,
						});
					}
				} catch (e) {
					mismatches.push({
						type: "metadata_error",
						message: `Error reading local metadata for ${filepath}: ${(e as Error).message}`,
					});
				}
				if (mismatches.length > 0) {
					files_to_move.push({
						filepath,
						mismatches,
					});
				}
			}
		} else {
			files_to_move.push({
				filepath,
				mismatches: [
					{
						type: "notfound",
						message: `Not found in cloud, with name ${entry_path}`,
					},
				],
			});
		}
	}
	console.log(`${total} files verified, ${files_to_move.length} files bad`);
	for (const file of files_to_move) {
		console.log(`${file.filepath}; ${file.mismatches.map((m) => m.message).join("; ")}
		`);
		if (config.move_removed_files) {
			await moveFileToRemoved(
				file.filepath,
				removedwithdate,
				config.base_directory,
			);
		}
	}

	return files_to_move.length;
}

async function waitforinput(msg: string) {
	if (process.stdout.isTTY) {
		console.log(msg);
		await new Promise((resolve) => process.stdin.once("data", resolve));
	}
}

async function getConfig() {
	const configfile = Bun.file(NPath.join(execDir, "config.json"));
	if (!(await configfile.exists())) {
		console.error("Config file not found, creating default config");
		if (process.platform === "win32") {
			const base_directory = await folder_Picker("Select the base directory");
			const removed_directory = await folder_Picker(
				"Select the removed directory",
			);
			await Bun.write(
				NPath.join(execDir, "config.json"),
				JSON.stringify(Config({ base_directory, removed_directory }), null, 2),
			);
		} else {
			await Bun.write(
				NPath.join(execDir, "config.json"),
				JSON.stringify(Config({}), null, 2),
			);
		}
	} else {
		await Bun.write(
			NPath.join(execDir, "config.json"),
			JSON.stringify(Config({}), null, 2),
		);
		await waitforinput("Press any key to exit...");
		process.exit(1);
	}
	const config = Config(await configfile.json());
	if (config instanceof type.errors) {
		console.error(
			"Config file is invalid, please fix it, or delete it and let it regenerate",
		);
		console.error(config.summary);
		await waitforinput("Press any key to exit...");
		process.exit(1);
	}
	return config;
}

// if bun, change to the directory of the script
let execDir = process.cwd();
if (process.argv[0] === "bun") {
	process.chdir(NPath.dirname(process.execPath));
	execDir = NPath.dirname(process.execPath);
}

async function main() {
	console.log("Version 2.2.0");
	const config = await getConfig();
	config.base_directory = NPath.resolve(execDir, config.base_directory);
	config.removed_directory = NPath.resolve(execDir, config.removed_directory);
	if (config.removed_directory.startsWith(config.base_directory)) {
		throw new Error(
			"Error: removed_directory must not be inside base_directory. Please adjust your config.json.",
		);
	}

	const PathRecord = flatTreeToPathRecordDFS(await getFlatTree());
	await sync(PathRecord, config);

	for (let i = 0; i < config.verify_retries; i++) {
		const bad = await verify(PathRecord, config);
		if (bad === 0) {
			break;
		}
		console.log(`Retrying ${bad} files`);
		await sync(PathRecord, config);
	}
	await waitforinput("Press any key to exit...");
}

async function run() {
	// this is a wrapper that catches errors and waits for input, because bun is a bitch and bytecode yells at me if i do this in the module scope
	try {
		await main();
	} catch (e) {
		if (e instanceof Error) {
			console.error(e.message);
		} else {
			console.error(e);
		}
		await waitforinput("Press any key to exit...");
		process.exit(1);
	}
}

run();
