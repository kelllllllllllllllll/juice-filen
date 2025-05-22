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
	"bun-linux-x64-baseline",
	"bun-linux-arm64",
	"bun-windows-x64",
	"bun-windows-x64-baseline",
	"bun-darwin-x64",
	"bun-darwin-x64-baseline",
	"bun-darwin-arm64",
	"bun-linux-x64-musl",
	"bun-linux-x64-musl-baseline",
	"bun-linux-arm64-musl",
];

await Promise.all(
	targets.flatMap((target) => {
		return [false].map(async (useBytecode) => {
			// bytecode is so buggy, it's not worth it
			const suffix = useBytecode ? "-bytecode" : "";
			let outfile = `${build_dir}/filen-${target.replace("bun-", "")}${suffix}`;
			if (target.includes("windows")) {
				outfile += ".exe";
			}
			const bytecodeFlag = useBytecode ? "--bytecode" : "";
			await $`bun build --compile --minify ${bytecodeFlag} --sourcemaps ./index.ts ./node_modules/bun-xattr/impl/Darwin.ts ./node_modules/bun-xattr/impl/Linux.ts --outfile ${outfile} --target ${target}`;
		});
	}),
);

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
