import fs from "node:fs/promises";
import NPath from "node:path";
import { type } from "arktype";
import { Sema } from "async-sema";
import { $ } from "bun";
import { Config, type ExtendedFile, type ExtendedFolder } from "./arktype";
import { download_file } from "./streamfile";
import { convertPath, flatTreeToPathRecordDFS, getFlatTree } from "./utils";

async function* walk(dir: string): AsyncGenerator<string> {
	for await (const d of await fs.opendir(dir)) {
		const entry = NPath.join(dir, d.name);
		if (d.isDirectory()) yield* walk(entry);
		else if (d.isFile()) yield entry;
	}
}
async function setCreationTime(filepath: string, creation: number) {
	if (process.platform !== "win32") {
		return;
	} // hell code, why the fuck does nodejs not support this?
	const escapedFilepath = filepath
		.replaceAll("'", "''")
		.replaceAll("[", "`[")
		.replaceAll("]", "`]")
		.replaceAll("’", "'’")
		.replaceAll("‘", "'‘");

	try {
		const result =
			await $`powershell -Command "\$creationUnixMs = ${creation.toFixed(0)}; \$newCreationTime = [DateTime]::SpecifyKind([DateTimeOffset]::FromUnixTimeMilliseconds(\$creationUnixMs).DateTime, [DateTimeKind]::Utc); Get-Item '${escapedFilepath}' | Set-ItemProperty -Name CreationTimeUtc -Value \$newCreationTime"`.quiet();
	} catch (e) {
		if (e instanceof $.ShellError) {
			console.log(filepath, escapedFilepath);
			console.log(e.stdout.toString(), e.stderr.toString());
		}
	}
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
		if (await fs.exists(filepath)) {
			const stats = await fs.stat(filepath);
			if (
				stats.size === entry.metadata.size &&
				stats.mtimeMs === entry.metadata.lastModified &&
				stats.birthtimeMs === entry.metadata.creation
			) {
				return 1;
			}
			return 2;
		}
		await fs.mkdir(NPath.dirname(filepath), { recursive: true });

		await download_file(entry, filepath, maxChunks);

		await fs.utimes(
			filepath,
			new Date(entry.metadata.lastModified),
			new Date(entry.metadata.lastModified),
		);
	}
	if (entry.kind === "folder") {
		await fs.mkdir(filepath, { recursive: true });
	}
	return 0;
}
async function sync(
	PathRecord: Record<string, ExtendedFile | ExtendedFolder>,
	config: Config,
) {
	let count = 0;
	let total = 0;
	const maxFiles = new Sema(128);
	const maxChunks = new Sema(1024);
	const maxPowershell = new Sema(32);

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
				.then(() => {
					return download_entry(entry, filePath, maxChunks);
				})
				.then((result) => {
					if (entry.kind === "file" && result === 0)
						maxPowershell // shelling out is slow, too many processes fucks shit up
							.acquire()
							.then(() => {
								return setCreationTime(filePath, entry.metadata.creation);
							})
							.finally(() => {
								maxPowershell.release();
							});
				})
				.then(() => {
					const trimmedname = entry.path[entry.path.length - 1];
					const length_of_total = total.toString().length;
					count++;
					if (entry.kind === "file") {
						process.stdout.write(
							`\r\x1b[2K${count.toString().padStart(length_of_total)}/${total} | ${maxFiles.nrWaiting().toString().padStart(length_of_total)} files waiting | ${maxChunks.nrWaiting()} chunks | Last download was ${trimmedname}`,
						);
					}
				})
				.finally(() => {
					maxFiles.release();
				}),
		);
	}
	total = promises.length;
	await Promise.all(promises);
	process.stdout.write("\x1B[?25h\r\n");
	await maxFiles.drain();
	await maxChunks.drain();
	if (process.platform === "win32") {
		await new Promise((resolve) => setTimeout(resolve, 1000)); // wait for powershell to exit
	}
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
			type: "size" | "mtime" | "btime" | "notfound";
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
				const stats = await fs.stat(filepath);
				const mismatches: {
					type: "size" | "mtime" | "btime" | "notfound";
					message: string;
				}[] = [];
				if (stats.size !== entry.metadata.size) {
					mismatches.push({
						type: "size",
						message: `On disk: ${stats.size} !== On cloud: ${entry.metadata.size}`,
					});
				}
				if (stats.mtimeMs !== entry.metadata.lastModified) {
					mismatches.push({
						type: "mtime",
						message: `On disk: ${stats.mtimeMs} !== On cloud: ${entry.metadata.lastModified}`,
					});
				}
				if (stats.birthtimeMs !== entry.metadata.creation) {
					mismatches.push({
						type: "btime",
						message: `On disk: ${stats.birthtimeMs} !== On cloud: ${entry.metadata.creation}`,
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
	console.log("Version 2.1.0");
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
		if (process.platform === "win32") {
			await new Promise((resolve) => setTimeout(resolve, 1000)); // wait for powershell to exit
		}
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
