import process from "node:process";
import { runBrowserCli } from "../src/browser-cli.js";

process.exitCode = await runBrowserCli(process.argv.slice(2));
