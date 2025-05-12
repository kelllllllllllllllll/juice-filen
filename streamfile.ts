import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import type { Sema } from "async-sema";
import type { ExtendedFile } from "./arktype";

const CHUNK_SIZE = 2 ** 20;

export async function download_chunk(
	region: string,
	bucket: string,
	uuid: string,
	chunk: number,
	key: string,
) {
	const egestURLs = [
		"https://egest.filen.io",
		"https://egest.filen.net",
		"https://egest.filen-1.net",
		"https://egest.filen-2.net",
		"https://egest.filen-3.net",
		"https://egest.filen-4.net",
		"https://egest.filen-5.net",
		"https://egest.filen-6.net",
	] as const;
	const host = egestURLs[Math.floor(Math.random() * egestURLs.length)];
	const url = `${host}/${region}/${bucket}/${uuid}/${chunk}`;
	const response = await fetch(url);
	const buffer = Buffer.from(await response.arrayBuffer());

	// Extract the IV (first 12 bytes)
	const ivBuffer = buffer.subarray(0, 12);

	// The last 16 bytes of ciphertext is the auth tag
	const encrypted = buffer.subarray(12, -16);
	const authTag = buffer.subarray(-16);

	// Create decipher with AES-256-GCM using utf-8 encoded key
	const decipher = createDecipheriv(
		"aes-256-gcm",
		Buffer.from(key, "utf-8"),
		ivBuffer,
	);
	decipher.setAuthTag(authTag);

	// Decrypt the data
	const decrypted = Buffer.concat([
		decipher.update(encrypted),
		decipher.final(),
	]);

	return decrypted;
}

export async function download_file(
	file: ExtendedFile,
	path: string,
	maxChunks: Sema,
) {
	const f = await fs.open(path, "w");

	const promises = Array.from({ length: file.chunks }, (_, i) =>
		maxChunks
			.acquire()
			.then(() =>
				download_chunk(
					file.region,
					file.bucket,
					file.uuid,
					i,
					file.metadata.key,
				).then((chunk) => f.write(chunk, 0, chunk.byteLength, i * CHUNK_SIZE)),
			)
			.finally(() => maxChunks.release()),
	);

	const results = await Promise.all(promises);

	await f.close();
}
