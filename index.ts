import fs from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { Sema } from "async-sema";
import { $ } from "bun";
import { convertToObject } from "typescript";
import { Config, type ExtendedFile, type ExtendedFolder } from "./arktype";
import { download_file } from "./streamfile";
import { getLocalMetadata, setLocalMetadata } from "./utils";
import {
	convertPath,
	flatTreeToPathRecordDFS,
	getFlatTree,
	tryCatch,
	walk,
} from "./utils";

async function folder_Picker(description: string) {
	if (process.platform !== "win32") {
		throw new Error("Folder picker is only supported on Windows");
	}
	const result =
		await $`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; \$folderBrowserDialog = New-Object System.Windows.Forms.FolderBrowserDialog; \$folderBrowserDialog.Description = '${description}'; \$folderBrowserDialog.ShowNewFolderButton = \$true; \$folderBrowserDialog.RootFolder = [System.Environment+SpecialFolder]::Desktop; \$folderBrowserDialog.AutoUpgradeEnabled = \$true; if (\$folderBrowserDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Host \$folderBrowserDialog.SelectedPath }"`
			.text()
			.then((s) => s.trim());

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
	const rel = path.relative(basepath, filepath);
	const finalpath = path.join(removedpath, rel);
	await fs.mkdir(path.dirname(finalpath), { recursive: true });
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
			// throwing in this block means redownloading, try catch around this whole block because io can fail a lot and js doesn't have exception types
			const fileExists = await fs.exists(filepath);
			if (!fileExists) {
				throw new Error("File does not exist, must download");
			}
			const localMetadata = await tryCatch(getLocalMetadata(filepath));
			if (localMetadata.error) {
				// this case means the file doesn't have a xattrs, so do a comparision with old attrs and if they match, write the xattrs then skip
				const stat = await fs.stat(filepath);
				if (stat.size !== entry.metadata.size) {
					throw new Error("File size mismatch, must download");
				}
				if (stat.mtimeMs !== entry.metadata.lastModified) {
					throw new Error("File mtime mismatch, must download");
				}
				if (
					process.platform === "win32" &&
					stat.birthtimeMs !== entry.metadata.creation
				) {
					throw new Error("File creation time mismatch, must download");
				}
				await setLocalMetadata(filepath, {
					uuid: entry.uuid,
					lastModified: entry.metadata.lastModified,
					creation: entry.metadata.creation,
					size: entry.metadata.size,
				});
				return 1;
			}

			if (typeof localMetadata.data === "string") {
				// this case means the file has invalid xattrs, so we need to redownload
				throw new Error("File has invalid xattrs, must download");
			}

			if (localMetadata.data) {
				// this case means the file has xattrs, so do a comparision with  remote metadata and if they match, skip, if they don't, redownload
				if (localMetadata.data.uuid !== entry.uuid) {
					throw new Error("File uuid mismatch, must download");
				}
				if (localMetadata.data.size !== entry.metadata.size) {
					throw new Error("File size mismatch, must download");
				}
				if (localMetadata.data.lastModified !== entry.metadata.lastModified) {
					throw new Error("File mtime mismatch, must download");
				}
				if (localMetadata.data.creation !== entry.metadata.creation) {
					throw new Error("File creation time mismatch, must download");
				}
				return 1;
			}
		} catch (e) {
			// If getRemoteMetadata throws, it means attributes are not set or file doesn't exist.
			// Proceed to download.
		}
		await fs.mkdir(path.dirname(filepath), { recursive: true });

		await download_file(entry, filepath, maxChunks);

		await setLocalMetadata(filepath, {
			uuid: entry.uuid,
			lastModified: entry.metadata.lastModified,
			creation: entry.metadata.creation,
			size: entry.metadata.size,
		});
	}
	if (entry.kind === "folder") {
		await fs.mkdir(filepath, { recursive: true });
		// For folders, we might want to set some default/derived metadata if applicable, xattrs and ads both work on folders but i can't think of any good use for extra metadata
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
	for (const [filePath, entry] of Object.entries(PathRecord)) {
		const absPath = path.resolve(config.base_directory, ...entry.path);
		process.stdout.write("\x1B[?25l");
		if (shouldSkipDownload(filePath, config)) {
			continue;
		}

		promises.push(
			maxFiles
				.acquire()
				.then(async () => {
					// Make this async to await download_entry
					const downloadResult = await download_entry(
						entry,
						absPath,
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
						await fs.unlink(absPath);
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
	const removedwithdate = path.join(
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
			path.relative(config.base_directory, filepath),
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
					const localMetadata = await getLocalMetadata(filepath);
					if (typeof localMetadata === "string") {
						mismatches.push({
							type: "metadata_error",
							message: localMetadata,
						});
						continue;
					}
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
	const configpath = path.join(execDir, "config.json");
	if (!(await fs.exists(configpath))) {
		console.error("Config file not found, creating default config");
		if (process.platform === "win32") {
			const base_directory = await folder_Picker("Select the base directory");
			const removed_directory = await folder_Picker(
				"Select the removed directory",
			);
			await fs.writeFile(
				configpath,
				JSON.stringify(Config({ base_directory, removed_directory }), null, 2),
			);
		} else {
			await fs.writeFile(configpath, JSON.stringify(Config({}), null, 2));
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const text = await fs.readFile(configpath, "utf-8");
	const config = type("string.json.parse").pipe(Config)(text);
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
	process.chdir(path.dirname(process.execPath));
	execDir = path.dirname(process.execPath);
}

async function main() {
	console.log("Version 2.3.1");
	const config = await getConfig();
	config.base_directory = path.resolve(execDir, config.base_directory);
	config.removed_directory = path.resolve(execDir, config.removed_directory);
	if (config.removed_directory.startsWith(config.base_directory)) {
		throw new Error(
			"Error: removed_directory must not be inside base_directory. Please adjust your config.json.",
		);
	}
	const getPathRecord = async (no_base: boolean) => {
		const FlatTree = await getFlatTree();
		if (no_base) {
			const base = FlatTree.folders.filter((f) => f.parent === "base");
			if (base.length === 0) {
				throw new Error("Base folder not found"); // i don't think this is possible but more likely than below
			}
			if (base.length > 1) {
				throw new Error("Multiple base folders found"); // i don't think this is possible
			}
			return flatTreeToPathRecordDFS(FlatTree, base[0]?.uuid);
		}
		return flatTreeToPathRecordDFS(FlatTree);
	};

	const PathRecord = await getPathRecord(config.no_base);

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
