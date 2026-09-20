import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BondSeatConnector, FileStore } from './connector.mjs';

export const DEFAULT_API_URL = 'https://6qq9f4msd4.execute-api.us-east-1.amazonaws.com/agent/v1';

export function createConnector(env = process.env) {
  return new BondSeatConnector({
    baseUrl: env.BONDSEAT_API_URL || DEFAULT_API_URL,
    store: new FileStore(env.BONDSEAT_STATE_FILE || join(homedir(), '.bondseat', 'connection.json')),
  });
}

// npm bin entry points are symlinks on Unix; compare resolved paths.
export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(realpathSync(process.argv[1])).href;
}
