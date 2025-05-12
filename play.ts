import fs from "node:fs/promises";
import type { ExtendedFolder } from "./arktype";
import type { ExtendedFile } from "./arktype";

const pathrecord = JSON.parse(
	await fs.readFile("pathrecord.json", "utf-8"),
) as Record<string, ExtendedFile | ExtendedFolder>;

for (const path in pathrecord) {
	const entry = pathrecord[path];
	if (!entry) continue;

	if (entry.kind === "file") {
		console.log(
			"-------------------------------------------------------------------",
		);
		console.log(entry.metadata.name);
		console.log(new Date(entry.metadata.creation).toISOString()); //creation date, milliseconds
		console.log(new Date(entry.metadata.lastModified).toISOString()); //last modified, milliseconds
		console.log(new Date(entry.timestamp * 1000).toISOString()); //upload date? seconds
	}
}
