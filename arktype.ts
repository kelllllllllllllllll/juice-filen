import { type } from "arktype";

export const Path = type("string[]#path");
const Folder = type({
	uuid: "string.uuid.v4",
	name: "string",
	parent: ["string.uuid.v4", "|", "'base'"],
	timestamp: "number.epoch",
});
const Metadata = type({
	name: "string",
	size: "number.integer >= 1",
	lastModified: "number.epoch",
	creation: "number.epoch",
	key: "string.alphanumeric",
	mime: "string",
});
const File = type({
	uuid: "string.uuid.v4",
	bucket: "string",
	region: "string",
	parent: ["string.uuid", "|", "'base'"],
	timestamp: "number.epoch",
	chunks: "number.integer >= 1",
	version: "number == 2",
	metadata: Metadata,
});
export const Entry = type({ name: "string", kind: "'file' | 'folder'" });
export const ExtendedFolder = Folder.merge({
	kind: "'folder'",
	path: Path,
	children: Entry.array(),
	size: "number.integer >= 0",
	chunks: "number.integer >= 0",
});
export const ExtendedFile = File.merge({
	kind: "'file'",
	path: Path,
});

export type File = typeof File.infer;
export type Folder = typeof Folder.infer;
export type ExtendedFile = typeof ExtendedFile.infer;
export type ExtendedFolder = typeof ExtendedFolder.infer;
export type Path = typeof Path.infer;
export const rawInput = type({
	files: File.array(),
	folders: Folder.array(),
});
export type Input = typeof rawInput.infer;

export const LocalMetadata = type({
	uuid: "string.uuid.v4",
	lastModified: "number.epoch",
	creation: "number.epoch",
	size: "number.integer >= 1",
});
export type LocalMetadata = typeof LocalMetadata.infer;

export const Config = type({
	version: "string.semver = '2.3.2'",
	no_base: "boolean = true",
	parent_uuid: "string.uuid = '607c110c-48e1-4248-bf45-0eb0dfd06fb9'",
	parent_password: "string = 'juicetracker'",
	parent_key: "string = 'mdbzIcGzl9HcgB1KkbxGSVxaw2f2Ao1v'",
	exclude: ["string[]", "=", () => ["/Studio Sessions"]],
	base_directory: "string = './downloads'",
	move_removed_files: "boolean = true",
	removed_directory: "string = './removed'",
	verify_retries: "number.integer >= 0 = 3",
	max_chunks: "number.integer >= 1 = 256",
	max_files: "number.integer >= 1 = 32",
});
export type Config = typeof Config.infer;
