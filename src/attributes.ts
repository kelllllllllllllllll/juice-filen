import fs from "node:fs/promises";
import { type as ostype } from "node:os";

let getxattrLinux: typeof import("bun-xattr/impl/Linux").getxattr | undefined;
let setxattrLinux: typeof import("bun-xattr/impl/Linux").setxattr | undefined;

let getxattrDarwin: typeof import("bun-xattr/impl/Darwin").getxattr | undefined;
let setxattrDarwin: typeof import("bun-xattr/impl/Darwin").setxattr | undefined;

export async function getxattr(
	target: string | number,
	key: string, // should probably start with user. causes errors otherwise
): Promise<Uint8Array> {
	const os = ostype();
	switch (os) {
		case "Linux": {
			if (!getxattrLinux) {
				getxattrLinux = (await import("bun-xattr/impl/Linux")).getxattr;
				return getxattrLinux(target, key);
			}
			return getxattrLinux(target, key);
		}
		case "Darwin": {
			if (!getxattrDarwin) {
				getxattrDarwin = (await import("bun-xattr/impl/Darwin")).getxattr;
				return getxattrDarwin(target, key);
			}
			return getxattrDarwin(target, key);
		}
		case "Windows_NT": {
			const data = await fs.readFile(`${target}:${key}`);
			return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		}
		default:
			throw new Error("Unsupported platform");
	}
}
export async function setxattr(
	target: string | number,
	key: string,
	value: Uint8Array | string,
) {
	const os = ostype();
	switch (os) {
		case "Linux": {
			if (!setxattrLinux) {
				setxattrLinux = (await import("bun-xattr/impl/Linux")).setxattr;
			}
			return setxattrLinux(target, key, value);
		}
		case "Darwin": {
			if (!setxattrDarwin) {
				setxattrDarwin = (await import("bun-xattr/impl/Darwin")).setxattr;
			}
			return setxattrDarwin(target, key, value);
		}
		case "Windows_NT": {
			return await fs.writeFile(`${target}:${key}`, value);
		}
		default:
			throw new Error("Unsupported platform");
	}
}
