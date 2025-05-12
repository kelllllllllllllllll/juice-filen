#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import { Config } from "./arktype";
const build_dir = "./dist";

// Clean up and recreate temp directory
await fs.rm(build_dir, { recursive: true, force: true });
await fs.mkdir(build_dir, { recursive: true });

await Bun.write(
	path.join(build_dir, "config.json"),
	JSON.stringify(Config({}), null, 2),
);

const targets = [
	"bun-linux-x64",
	"bun-linux-arm64",
	"bun-windows-x64",
	"bun-darwin-x64",
	"bun-darwin-arm64",
	"bun-linux-x64-musl",
	"bun-linux-arm64-musl",
];

for (const target of targets) {
	let outfile = `${build_dir}/filen-${target.replace("bun-", "")}`;
	if (target.includes("windows")) {
		outfile += ".exe";
	}
	await $`bun build --compile --minify --bytecode ./index.ts --outfile ${outfile} --target ${target}`;
}

// Change to temp directory and run the executable
if (process.argv[1] === "run") {
	console.log(process.argv);
	const originalDir = process.cwd();
	try {
		process.chdir("./temp");
		const currentPlatform =
			process.platform === "win32" ? "windows" : process.platform;
		const currentArch = process.arch;
		const executable = `filen-${currentPlatform}-${currentArch}${currentPlatform === "windows" ? ".exe" : ""}`;
		if (await Bun.file(executable).exists()) {
			const result = await $`./${executable.trim()}`;
		} else {
			console.error(`${executable} does not exist`);
			process.exit(1);
		}
	} finally {
		process.chdir(originalDir);
	}
}
