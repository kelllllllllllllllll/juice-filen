import fs from "node:fs/promises";
import path from "node:path";
import { version } from "../package.json";

import { ArkErrors, type } from "arktype";
import { semver } from "bun";
import {
	type Entry,
	type ExtendedFile,
	type ExtendedFolder,
	type File,
	type Folder,
	type Input,
	LocalMetadata,
	Path,
	rawInput,
} from "./arktype";
import { getxattr, setxattr } from "./attributes";
import { getDirectoryListing } from "./myfilensdk";
import { deriveKeyFromPassword } from "./myfilensdk";
import { directoryPublicLinkInfo } from "./myfilensdk";

export function flatTreeToPathRecordDFS(input: Input, baseUuid = "base") {
	const record: Record<string, ExtendedFolder | ExtendedFile> = {};

	// build quick lookup of folder‐children
	const folderChildren = new Map<string, Folder[]>();
	for (const folder of input.folders) {
		const arr = folderChildren.get(folder.parent) ?? [];
		arr.push(folder);
		folderChildren.set(folder.parent, arr);
	}

	// build quick lookup of file‐children
	const fileChildren = new Map<string, File[]>();
	for (const file of input.files) {
		const arr = fileChildren.get(file.parent) ?? [];
		arr.push(file);
		fileChildren.set(file.parent, arr);
	}

	function dfs(parentUuid: string, curPath: string[]) {
		const kidsFolders = folderChildren.get(parentUuid) ?? [];
		const kidsFiles = fileChildren.get(parentUuid) ?? [];
		let totalChunks = 0;
		let totalSize = 0;

		// 1) Recurse into sub‐folders and accumulate their sizes
		for (const folder of kidsFolders) {
			const { totalSize: oldtotalSize, totalChunks: oldtotalChunks } = dfs(
				folder.uuid,
				[...curPath, folder.name],
			);
			totalSize += oldtotalSize;
			totalChunks += oldtotalChunks;
		}

		// 2) Add each file entry and accumulate its size
		for (const file of kidsFiles) {
			const p = [...curPath, file.metadata.name];
			record[`/${p.join("/")}`] = {
				...file,
				path: Path.assert(p),
				kind: "file",
			};
			totalSize += file.metadata.size;
			totalChunks += file.chunks;
		}

		// 3) Build the children list for this folder
		const childrenNames = [
			...kidsFolders.map((x) => ({ name: x.name, kind: "folder" })),
			...kidsFiles.map((x) => ({ name: x.metadata.name, kind: "file" })),
		] as (typeof Entry.infer)[];

		// 4) Finally, set this folder's entry with the computed size
		if (parentUuid === "base") {
			record["/"] = {
				uuid: "base",
				parent: "",
				name: "",
				kind: "folder",
				path: [] as unknown as Path,
				children: childrenNames,
				timestamp: Date.now(),
				size: totalSize,
				chunks: totalChunks,
			};
		} else {
			const folder = folderMap.get(parentUuid);
			if (!folder) throw new Error("Folder not found");
			record[`/${curPath.join("/")}/`] = {
				...folder,
				kind: "folder",
				path: curPath as Path,
				children: childrenNames,
				size: totalSize,
				chunks: totalChunks,
			};
		}

		return { totalSize, totalChunks };
	}

	// map uuid → Folder for lookup in dfs
	const folderMap = new Map(input.folders.map((f) => [f.uuid, f]));
	// start at virtual root
	dfs(baseUuid, []);
	return record;
}

const config = {
	parent_uuid: "607c110c-48e1-4248-bf45-0eb0dfd06fb9",
	parent_password: "juicetracker",
	parent_key: "mdbzIcGzl9HcgB1KkbxGSVxaw2f2Ao1v",
};

export async function getFlatTree() {
	const dirInfo = await directoryPublicLinkInfo({
		uuid: config.parent_uuid,
		key: config.parent_key,
	});

	// Derive password
	const derivedPassword = await deriveKeyFromPassword({
		password: config.parent_password,
		salt: dirInfo.salt,
		iterations: 200000,
		hash: "sha512",
		bitLength: 512,
	});

	// Get directory listing
	const data = await getDirectoryListing({
		uuid: config.parent_uuid,
		parent: dirInfo.parent,
		password: Buffer.from(derivedPassword).toString("hex"),
		key: config.parent_key,
	});

	return rawInput.assert(data);
}

export function convertPath(from: string, to: "win32" | "posix" | "mixed") {
	const RE_WIN_DEVICE_ROOT = /^([A-Za-z]):[\\\/]+/;
	const RE_POSIX_DEVICE_ROOT = /^\/([A-Za-z])\//;

	const out = from;
	switch (to) {
		case "win32": {
			const parts = RE_POSIX_DEVICE_ROOT.exec(out);
			if (parts) {
				const device = `${parts[1]}:\\`;
				out.replace(RE_POSIX_DEVICE_ROOT, device);
			}
			return out.replace("/", "\\");
		}
		case "mixed": {
			{
				const parts = RE_POSIX_DEVICE_ROOT.exec(out);
				if (parts) {
					const device = `${parts[1]}:/`;
					out.replace(RE_POSIX_DEVICE_ROOT, device);
				} else {
					const parts = RE_WIN_DEVICE_ROOT.exec(out);
					if (parts) {
						const device = `${parts[1]}:/`;
						out.replace(RE_WIN_DEVICE_ROOT, device);
					}
				}
				return out.replaceAll("\\", "/");
			}
		}
		case "posix": {
			const parts = RE_WIN_DEVICE_ROOT.exec(out);
			if (parts) {
				const device = `/${parts[1]?.toLowerCase()}/`;
				out.replace(RE_WIN_DEVICE_ROOT, device);
			}
			return out.replaceAll("\\", "/");
		}
	}
}

// Types for the result object with discriminated union
type Success<T> = {
	data: T;
	error: null;
};

type Failure<E> = {
	data: null;
	error: E;
};

type Result<T, E = Error> = Success<T> | Failure<E>;

// Main wrapper function
export async function tryCatch<T, E = Error>(
	promise: Promise<T>,
): Promise<Result<T, E>> {
	try {
		const data = await promise;
		return { data, error: null };
	} catch (error) {
		return { data: null, error: error as E };
	}
}
export async function* walk(dir: string): AsyncGenerator<string> {
	for await (const d of await fs.opendir(dir)) {
		const entry = path.join(dir, d.name);
		if (d.isDirectory()) yield* walk(entry);
		else if (d.isFile()) yield entry;
	}
}

export async function setLocalMetadata(path: string, metadata: LocalMetadata) {
	await setxattr(path, "user.filen", JSON.stringify(metadata));
}
export async function getLocalMetadata(
	path: string,
): Promise<LocalMetadata | string> {
	const data = await getxattr(path, "user.filen");
	const text = new TextDecoder().decode(data);
	const metadata = type("string.json.parse").pipe(LocalMetadata)(text);
	if (metadata instanceof ArkErrors) {
		return metadata.summary;
	}
	return metadata;
}

export async function check_for_updates() {
	console.log("Checking for updates...");
	const response = await fetch(
		"https://api.github.com/repos/kelllllllllllllllll/juice-filen/releases/latest",
	);
	const data = type("string.json.parse").pipe(
		type({
			tag_name: [
				["string", "=>", (s: string) => s.slice(1)],
				"|>",
				"string.semver",
			],
			html_url: "string.url",
		}),
	)(await response.text());
	if (data instanceof ArkErrors) {
		console.error("Error checking for updates");
		console.error(data.summary);
		return;
	}

	if (semver.order(data.tag_name, version) === 1) {
		console.log(`Update available: ${data.tag_name}`);
		console.log(data.html_url);
	} else {
		console.log("No updates available");
	}
}
