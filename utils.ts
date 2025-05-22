import fs from "node:fs/promises";
import {
	type Entry,
	type ExtendedFile,
	type ExtendedFolder,
	type File,
	type Folder,
	type Input,
	Path,
	RemoteMetadata,
	rawInput,
} from "./arktype";
import { getDirectoryListing } from "./mysdk";
import { deriveKeyFromPassword } from "./mysdk";
import { directoryPublicLinkInfo } from "./mysdk";

export function flatTreeToPathRecordDFS(input: Input) {
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
	dfs("base", []);
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

let getAttributeUnix: typeof import("@napi-rs/xattr").getAttribute;
let setAttributeUnix: typeof import("@napi-rs/xattr").setAttribute;

if (process.platform !== "win32") {
	setupXattr();
}
import "@napi-rs/xattr-linux-x64-musl";
import { ArkErrors, type } from "arktype";
async function setupXattr() {
	// seperate function so bun build with bytecode doesn't fail
	({ getAttribute: getAttributeUnix, setAttribute: setAttributeUnix } =
		await import("@napi-rs/xattr"));
	await import("@napi-rs/xattr-linux-x64-musl");
}

export async function getAttribute(path: string, name: string) {
	if (process.platform === "win32") {
		return await fs.readFile(`${path}:${name}`);
	}
	const data = await getAttributeUnix(path, name);
	if (!data) {
		throw new Error("Attribute not found");
	}
	return data;
}

export async function setAttribute(path: string, name: string, value: Buffer) {
	if (process.platform === "win32") {
		return await fs.writeFile(`${path}:${name}`, value);
	}
	return await setAttributeUnix(path, name, value);
}

export async function setRemoteMetadata(
	path: string,
	metadata: RemoteMetadata,
) {
	await setAttribute(path, "filen", Buffer.from(JSON.stringify(metadata)));
}
export async function getRemoteMetadata(
	path: string,
): Promise<RemoteMetadata | null> {
	const data = (await getAttribute(path, "filen")).toString("utf-8");
	const metadata = type("string.json.parse").pipe(RemoteMetadata)(data);
	if (metadata instanceof ArkErrors) {
		return null;
	}
	return metadata;
}
