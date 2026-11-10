// @gate-input whole-tree — it runs the served install script under sh, which the guard cannot see
// into; the script reads only this file's scratch directory and the routes on loopback.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exists } from '../../tests/helpers/install-world.js';
import {
  LONG,
  MARKETPLACE,
  type PluginInstall,
  type PluginInstallWorld,
  pluginInstallWorld,
  TOKEN,
  VERSION,
} from '../../tests/helpers/plugin-install-world.js';

// REQ-25 BC-4: one command Forge serves installs the forge plugin with only a Forge token, saves the
// account, and run again updates it. The served script runs for real — sh, curl, tar, node — in a
// scratch HOME, against a stand-in `claude` and the stand-in `forge` the archive's link-cli places
// (`plugin-install-world.ts`). The archive is written by core's own tar, so the system tar reading it
// here is what proves the two agree.

let w: PluginInstallWorld;

beforeAll(async () => {
  w = await pluginInstallWorld(async () => (await import('./install-routes.js')).installRoutes);
});

afterAll(async () => {
  await w.close();
});

const dest = (run: PluginInstall) => join(run.home, '.forge', 'plugin');
const cached = (run: PluginInstall) =>
  join(run.home, '.claude', 'plugins', 'cache', MARKETPLACE, 'forge', VERSION);

/** Every file under `dir` whose text holds `needle`. */
async function holding(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes(needle)) found.push(path);
  }
  return found;
}

describe('REQ-25 BC-4: the served plugin install, run on a machine', () => {
  it('installs the marketplace it downloaded with the token, the plugin from it, its commands and the account', async () => {
    const run = await w.install('fresh', { args: ['--token', TOKEN] });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(w.bearer).toBe(`Bearer ${TOKEN}`);
    expect(run.stdout).toContain(
      `Downloading the forge plugin from ${w.base}/api/install/plugin.tar.gz...`,
    );
    expect(run.stdout).toContain(`Installed forge ${VERSION} from ${MARKETPLACE}`);
    // tar read core's tar, the long path's pax header included
    expect(await readFile(join(dest(run), LONG), 'utf8')).toBe('long\n');
    expect(run.claude).toEqual([
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', dest(run)],
      ['plugin', 'list', '--json'],
      ['plugin', 'install', `forge@${MARKETPLACE}`],
      ['plugin', 'list', '--json'],
    ]);
    expect(run.linked).toEqual([cached(run)]);
    expect(run.forge).toEqual([`doctor --url ${w.base} --token ${TOKEN}`]);
    // the token went to the doctor, which keeps the account; the script wrote it nowhere itself
    expect(await holding(run.home, TOKEN)).toEqual([]);
  });

  it('run again, it updates the marketplace and the plugin it installed rather than adding them twice', async () => {
    const run = await w.install('fresh', { args: [`--token=${TOKEN}`] });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.claude).toEqual([
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'update', MARKETPLACE],
      ['plugin', 'list', '--json'],
      ['plugin', 'update', `forge@${MARKETPLACE}`],
      ['plugin', 'list', '--json'],
    ]);
    expect(await exists(`${dest(run)}.old`)).toBe(false);
    expect(await exists(`${dest(run)}.new`)).toBe(false);
  });

  describe('every failure exits non-zero, refused by name', () => {
    it('a marketplace of the same name from elsewhere: INSTALL_PLUGIN_MARKETPLACE_ELSEWHERE, and nothing is placed', async () => {
      const run = await w.install('elsewhere', {
        args: ['--token', TOKEN],
        marketplaces: [{ name: MARKETPLACE, installLocation: '/srv/forge-plugin' }],
      });

      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_PLUGIN_MARKETPLACE_ELSEWHERE: Claude Code already has a marketplace named ${MARKETPLACE}, from /srv/forge-plugin, and this install keeps its copy at ${dest(run)}; it does not take that name over. Remove the other one (claude plugin marketplace remove ${MARKETPLACE}), then run the install command again. Nothing was installed.\n`,
      );
      expect(await exists(join(run.home, '.forge'))).toBe(false);
      expect(run.claude).toEqual([['plugin', 'marketplace', 'list', '--json']]);
    });

    it('a token core refuses: INSTALL_PLUGIN_TOKEN_REFUSED carrying what core said', async () => {
      const wrong = `forge_pat_dev_${'cd'.repeat(32)}`;
      const run = await w.install('refused-token', { args: ['--token', wrong] });

      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_PLUGIN_TOKEN_REFUSED: ${w.base} refused the token with HTTP 401: INVALID_TOKEN; nothing was installed. Make a token under Settings → API Tokens at ${w.base}/settings?tab=tokens, then run the install command again with it.\n`,
      );
      expect(run.claude).toEqual([]);
      expect(await exists(join(run.home, '.forge'))).toBe(false);
    });

    it('an archive core will not serve: INSTALL_PLUGIN_DOWNLOAD_REFUSED naming its refusal', async () => {
      w.refusal = {
        status: 503,
        body: { code: 'PLUGIN_ARCHIVE_UNDESIGNATED', detail: 'no forge plugin is designated' },
      };
      try {
        const run = await w.install('undesignated', { args: ['--token', TOKEN] });

        expect(run.code).toBe(1);
        expect(run.stderr).toBe(
          `INSTALL_PLUGIN_DOWNLOAD_REFUSED: ${w.base} answered the download of ${w.base}/api/install/plugin.tar.gz with HTTP 503: PLUGIN_ARCHIVE_UNDESIGNATED: no forge plugin is designated; nothing was installed. This machine reached ${w.base}, so its network is not the cause: show this message to your Forge admin.\n`,
        );
        expect(await exists(join(run.home, '.forge'))).toBe(false);
      } finally {
        w.refusal = null;
      }
    });

    it('no token and no terminal to ask on: INSTALL_PLUGIN_TOKEN_MISSING', async () => {
      const run = await w.install('no-token');

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^INSTALL_PLUGIN_TOKEN_MISSING: /);
      expect(run.claude).toEqual([]);
    });

    it('something that is not a Forge token: INSTALL_PLUGIN_TOKEN_MALFORMED, before anything is asked', async () => {
      const run = await w.install('placeholder', { args: ['--token', '<pat>'] });

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(
        /^INSTALL_PLUGIN_TOKEN_MALFORMED: what was given is not a Forge token/,
      );
      expect(run.claude).toEqual([]);
    });

    it('an option it does not take: INSTALL_PLUGIN_USAGE naming it', async () => {
      const run = await w.install('usage', { args: ['--tokne', TOKEN] });

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^INSTALL_PLUGIN_USAGE: --tokne is not an option of this install/);
    });

    it('no claude on the PATH: INSTALL_PLUGIN_TOOL_MISSING naming it', async () => {
      const run = await w.install('no-claude', { args: ['--token', TOKEN], noClaude: true });

      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(
        /^INSTALL_PLUGIN_TOOL_MISSING: this machine has no claude on its PATH\./,
      );
    });

    it('a claude call that fails: INSTALL_PLUGIN_CLAUDE_FAILED naming the call and what claude said', async () => {
      const run = await w.install('install-fails', {
        args: ['--token', TOKEN],
        claudeFails: 'plugin install',
      });

      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_PLUGIN_CLAUDE_FAILED: \`claude plugin install forge@${MARKETPLACE}\` failed (exit 3: stand-in claude refused: plugin install forge@${MARKETPLACE}). The plugin's files are at ${dest(run)}. Deal with what Claude Code said, then run the install command again.\n`,
      );
    });

    it('a doctor that finds the machine lacking: INSTALL_PLUGIN_DOCTOR_FAILED, the plugin installed', async () => {
      const run = await w.install('doctor-fails', { args: ['--token', TOKEN], doctorExit: 1 });

      expect(run.code).toBe(1);
      expect(run.stderr).toBe(
        `INSTALL_PLUGIN_DOCTOR_FAILED: forge ${VERSION} is installed, and forge doctor (exit 1) names above what this machine still lacks; run forge doctor again once that is done.\n`,
      );
      expect(run.forge).toEqual([`doctor --url ${w.base} --token ${TOKEN}`]);
    });
  });
});
