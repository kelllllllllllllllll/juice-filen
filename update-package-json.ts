import fs from "node:fs";
import pkg from "./package.json";
const packageJsonPath = "package.json";
const NEW_VERSION = Bun.env.NEW_VERSION;
if (!NEW_VERSION) {
	throw new Error("NEW_VERSION is not set");
}

if (pkg.version !== NEW_VERSION) {
	pkg.version = NEW_VERSION;
	fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
	console.log(`Updated ${packageJsonPath} to version ${NEW_VERSION}`);
} else {
	console.log(`${packageJsonPath} version already matches ${NEW_VERSION}`);
}
