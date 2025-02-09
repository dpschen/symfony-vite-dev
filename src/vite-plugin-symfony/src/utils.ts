import { type ResolvedConfig } from "vite";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "net";
import { writeFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import type { RenderedChunk, OutputChunk, OutputAsset, NormalizedOutputOptions } from "rollup";
import { resolve, extname, relative } from "path";
import { StringMapping, DevServerUrl, VitePluginSymfonyOptions, FileInfos, ParsedInputs, HashAlgorithm } from "./types";
import { BinaryLike, createHash } from "node:crypto";

export const isWindows = os.platform() === "win32";

export function parseVersionString(str: string) {
  const [major, minor, patch] = str.split(".").map((nb) => parseInt(nb));
  return [str, major ?? 0, minor ?? 0, patch ?? 0];
}

export function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function normalizePath(id: string): string {
  return path.posix.normalize(isWindows ? slash(id) : id);
}

export function getLegacyName(name: string) {
  const ext = extname(name);
  const endPos = ext.length !== 0 ? -ext.length : undefined;
  name = name.slice(0, endPos) + "-legacy" + ext;
  return name;
}

export function isIpv6(address: AddressInfo): boolean {
  return (
    address.family === "IPv6" ||
    // In node >=18.0 <18.4 this was an integer value. This was changed in a minor version.
    // See: https://github.com/laravel/vite-plugin/issues/103
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore-next-line
    address.family === 6
  );
}

export const writeJson = (filePath: string, jsonData: any) => {
  try {
    writeFileSync(filePath, JSON.stringify(jsonData, null, 2));
  } catch (err) {
    throw new Error(`Error writing ${path.basename(filePath)}: ${err.message}`);
  }
};

export const emptyDir = (dir: string) => {
  const files = readdirSync(dir);
  for (const file of files) {
    rmSync(join(dir, file), { recursive: true });
  }
};

/* not imported from vite because we don't want vite in package.json dependencies */
const FS_PREFIX = `/@fs/`;
const VALID_ID_PREFIX = `/@id/`;
const CLIENT_PUBLIC_PATH = `/@vite/client`;
const ENV_PUBLIC_PATH = `/@vite/env`;

const importQueryRE = /(\?|&)import=?(?:&|$)/;
export const isImportRequest = (url: string): boolean => importQueryRE.test(url);

const internalPrefixes = [FS_PREFIX, VALID_ID_PREFIX, CLIENT_PUBLIC_PATH, ENV_PUBLIC_PATH];
const InternalPrefixRE = new RegExp(`^(?:${internalPrefixes.join("|")})`);
export const isInternalRequest = (url: string): boolean => InternalPrefixRE.test(url);

const CSS_LANGS_RE = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const cssModuleRE = new RegExp(`\\.module${CSS_LANGS_RE.source}`);
const commonjsProxyRE = /\?commonjs-proxy/;
const isCSSRequest = (request) => CSS_LANGS_RE.test(request);

const polyfillId = "\0vite/legacy-polyfills";

export function resolveDevServerUrl(
  address: AddressInfo,
  config: ResolvedConfig,
  pluginOptions: VitePluginSymfonyOptions,
): DevServerUrl {
  if (pluginOptions.originOverride) {
    return pluginOptions.originOverride as DevServerUrl;
  }

  if (config.server?.origin) {
    return config.server.origin as DevServerUrl;
  }

  const configHmrProtocol = typeof config.server.hmr === "object" ? config.server.hmr.protocol : null;
  const clientProtocol = configHmrProtocol ? (configHmrProtocol === "wss" ? "https" : "http") : null;
  const serverProtocol = config.server.https ? "https" : "http";
  const protocol = clientProtocol ?? serverProtocol;

  const configHmrHost = typeof config.server.hmr === "object" ? config.server.hmr.host : null;
  const configHost = typeof config.server.host === "string" ? config.server.host : null;
  const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address;
  const host = configHmrHost ?? pluginOptions.viteDevServerHostname ?? configHost ?? serverAddress;

  const configHmrClientPort = typeof config.server.hmr === "object" ? config.server.hmr.clientPort : null;
  const port = configHmrClientPort ?? address.port;

  return `${protocol}://${host}:${port}`;
}

export const isAddressInfo = (x: string | AddressInfo | null | undefined): x is AddressInfo => typeof x === "object";

export const isCssEntryPoint = (chunk: RenderedChunk) => {
  if (!chunk.isEntry) {
    return false;
  }
  let isPureCssChunk = true;
  const ids = Object.keys(chunk.modules);
  for (const id of ids) {
    if (!isCSSRequest(id) || cssModuleRE.test(id) || commonjsProxyRE.test(id)) {
      isPureCssChunk = false;
    }
  }

  if (isPureCssChunk) {
    return chunk?.viteMetadata.importedCss.size === 1 ?? false;
  }

  return false;
};

export const getFileInfos = (
  chunk: OutputChunk | OutputAsset,
  inputRelPath,
  pluginOptions: VitePluginSymfonyOptions,
): FileInfos => {
  const alg = pluginOptions.sriAlgorithm;
  if (chunk.type === "asset") {
    if (chunk.fileName.endsWith(".css")) {
      return {
        css: [chunk.fileName],
        hash: alg === false ? null : generateHash(chunk.source, alg),
        inputRelPath,
        outputRelPath: chunk.fileName,
        type: "css",
      };
    } else {
      return {
        hash: alg === false ? null : generateHash(chunk.source, alg),
        inputRelPath,
        outputRelPath: chunk.fileName,
        type: "asset",
      };
    }
  } else if (chunk.type === "chunk") {
    const { imports, dynamicImports, viteMetadata, fileName } = chunk;

    return {
      assets: Array.from(viteMetadata.importedAssets),
      css: Array.from(viteMetadata.importedCss),
      hash: alg === false ? null : generateHash(chunk.code, alg),
      imports: imports,
      inputRelPath,
      js: [fileName],
      outputRelPath: fileName,
      preload: [],
      dynamic: dynamicImports,
      type: "js",
    };
  }
};

function generateHash(source: BinaryLike, alg: HashAlgorithm) {
  if (alg === false) {
    return null;
  }
  const hash = createHash(alg).update(source).digest().toString("base64");
  return `${alg}-${hash}`;
}

export const prepareRollupInputs = (config: ResolvedConfig): ParsedInputs => {
  const inputParsed: ParsedInputs = {};

  for (const [entryName, inputRelPath] of Object.entries(config.build.rollupOptions.input)) {
    const entryAbsolutePath = normalizePath(resolve(config.root, inputRelPath));

    const extension = extname(inputRelPath);

    const inputType =
      [".css", ".scss", ".sass", ".less", ".styl", ".stylus", ".postcss"].indexOf(extension) !== -1 ? "css" : "js";

    const entryRelativePath = normalizePath(relative(config.root, entryAbsolutePath));

    inputParsed[entryName] = {
      inputType,
      inputRelPath: entryRelativePath,
    };
  }

  return inputParsed;
};

const getKeyByValue = (object, value) => {
  return Object.keys(object).find((key) => object[key] === value);
};

export const getInputRelPath = (
  chunk: OutputAsset | OutputChunk,
  options: NormalizedOutputOptions,
  config: ResolvedConfig,
  inputRelPath2outputRelPath: StringMapping = null,
): string => {
  if (chunk.type === "asset" || !chunk.facadeModuleId) {
    if (inputRelPath2outputRelPath !== null) {
      const inputRelPath = getKeyByValue(inputRelPath2outputRelPath, chunk.fileName);
      if (inputRelPath) {
        return inputRelPath;
      }
    }

    return `_${chunk.fileName}`;
  }

  if ([polyfillId].indexOf(chunk.facadeModuleId) !== -1) {
    return chunk.facadeModuleId.replace(/\0/g, "");
  }

  let inputRelPath = normalizePath(path.relative(config.root, chunk.facadeModuleId));

  /* when we generate legacy files, format === 'system'. after format is other value like 'es' */
  if (options.format === "system" && !chunk.name.includes("-legacy")) {
    inputRelPath = getLegacyName(inputRelPath);
  }
  return inputRelPath.replace(/\0/g, "");
};
