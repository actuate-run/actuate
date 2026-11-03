/** `node --import` this to run TypeScript tests with test-loader.ts. */
import { register } from "node:module";

register(new URL(/\.ts$/.test(import.meta.url) ? "./test-loader.ts" : "./test-loader.js", import.meta.url));
