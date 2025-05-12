import * as nodeCrypto from "node:crypto";

import { type } from "arktype";

type KeyUsage = "encrypt" | "decrypt" | "deriveBits" | "deriveKey";

const encryptedFile = type({
	uuid: "string.uuid.v4",
	bucket: "string",
	region: "string",
	metadata: "string",
	chunks: "number",
	parent: "string.uuid.v4",
	version: "number",
	timestamp: "number",
});
const encryptedlistDirType = type({
	status: "true",
	message: "string",
	code: "string",
	data: {
		folders: [
			{
				uuid: "string.uuid.v4",
				name: "string",
				parent: "string.uuid.v4 | 'base'",
				timestamp: "number",
			},
			"[]",
		],
		files: encryptedFile.array(),
	},
});

const fileMetadataType = type({
	name: "string",
	size: "number",
	mime: "string",
	lastModified: "number",
	key: "string",
	creation: "number",
});

export const DirectoryListingSchema = encryptedlistDirType.get("data").merge({
	files: [encryptedFile.merge({ metadata: fileMetadataType }), "[]"],
});

export type DirectoryListing = typeof DirectoryListingSchema.infer;
export async function importPBKDF2Key({
	key,
	mode = ["encrypt"],
}: {
	key: string;
	mode?: KeyUsage[];
}) {
	const importedPBKF2Key = await globalThis.crypto.subtle.importKey(
		"raw",
		Buffer.from(key, "utf-8"),
		{
			name: "PBKDF2",
		},
		false,
		mode,
	);

	return importedPBKF2Key;
}

export async function deriveKeyFromPassword({
	password,
	salt,
	iterations,
	hash,
	bitLength,
}: {
	password: string;
	salt: string;
	iterations: number;
	hash: "sha512";
	bitLength: 256 | 512;
}): Promise<Buffer> {
	const bits = await globalThis.crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: Buffer.from(salt, "utf-8"),
			iterations: iterations,
			hash: {
				name: hash === "sha512" ? "SHA-512" : hash,
			},
		},
		await importPBKDF2Key({
			key: password,
			mode: ["deriveBits"],
		}),
		bitLength,
	);

	const key = Buffer.from(bits);

	return key;
}

async function metadataDecrypt({
	metadata,
	key,
}: { metadata: string; key: string }): Promise<string> {
	if (key.length === 0) {
		throw new Error("Invalid key.");
	}
	const keyBuffer = await deriveKeyFromPassword({
		password: key,
		salt: key,
		iterations: 1,
		hash: "sha512",
		bitLength: 256,
	});
	const ivBuffer = Buffer.from(metadata.slice(3, 15), "utf-8");
	const encrypted = Buffer.from(metadata.slice(15), "base64");

	const authTag = encrypted.subarray(-16);
	const cipherText = encrypted.subarray(0, encrypted.byteLength - 16);
	const decipher = nodeCrypto.createDecipheriv(
		"aes-256-gcm",
		keyBuffer,
		ivBuffer,
	);

	decipher.setAuthTag(authTag);

	return Buffer.concat([
		decipher.update(cipherText),
		decipher.final(),
	]).toString("utf-8");
}

export async function getDirectoryListing({
	uuid,
	parent,
	password,
	key,
}: {
	uuid: string;
	parent: string;
	password: string;
	key: string;
}) {
	const response = await fetch(
		"https://gateway.filen.io/v3/dir/download/link",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				uuid: uuid,
				parent: parent,
				password: password,
			}),
		},
	);

	const responseData = await response.json();
	const parsedData = encryptedlistDirType(responseData);

	if (parsedData instanceof type.errors) {
		throw new Error(`Invalid response data: ${parsedData.summary}`);
	}

	const decryptedFolders = await Promise.all(
		parsedData.data.folders.map(async (folder) => {
			const decryptedName = await metadataDecrypt({
				metadata: folder.name,
				key,
			});
			return {
				...folder,
				name: JSON.parse(decryptedName).name,
			};
		}),
	);

	const decryptedFiles = await Promise.all(
		parsedData.data.files.map(async (file) => {
			const decryptedMetadata = await metadataDecrypt({
				metadata: file.metadata,
				key: key,
			});
			return {
				...file,
				metadata: JSON.parse(decryptedMetadata),
			};
		}),
	);

	const decryptedData = DirectoryListingSchema({
		folders: decryptedFolders,
		files: decryptedFiles,
	});

	if (decryptedData instanceof type.errors) {
		throw new Error(`Invalid decrypted data: ${decryptedData.summary}`);
	}

	return decryptedData;
}

const DirLinkInfoMetadataType = type({
	name: "string",
});

const encryptedDirLinkInfoType = type({
	status: "true",
	message: "string",
	code: "string",
	data: {
		parent: "string.uuid.v4",
		metadata: "string",
		timestamp: "number",
		hasPassword: "boolean",
		salt: "string",
		downloadBtn: "boolean",
	},
});

export async function directoryPublicLinkInfo({
	uuid,
	key,
}: {
	uuid: string;
	key: string;
}) {
	const response = await fetch("https://gateway.filen.io/v3/dir/link/info", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			uuid: uuid,
		}),
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch directory info: ${response.statusText}`);
	}
	const data = await response.json();
	const parsedData = encryptedDirLinkInfoType(data);
	if (parsedData instanceof type.errors) {
		throw new Error(`Invalid response data: ${parsedData.summary}`);
	}
	const decryptedMetadata = await metadataDecrypt({
		metadata: parsedData.data.metadata,
		key: key,
	});
	const decryptedData = DirLinkInfoMetadataType(JSON.parse(decryptedMetadata));
	if (decryptedData instanceof type.errors) {
		throw new Error(`Invalid decrypted data: ${decryptedData.summary}`);
	}
	return {
		...parsedData.data,
		metadata: decryptedData,
	};
}
