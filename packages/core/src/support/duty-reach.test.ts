import { describe, expect, it } from 'vitest';
import { boxReachIn } from './duty-reach.js';

describe('boxReachIn: what of the box a switch duty names (ISS-775)', () => {
  it.each([
    [
      'Writes its branch into /home/dev/orbit-babo/handover.md',
      'the box path /home/dev/orbit-babo/handover.md',
    ],
    [
      'Reads ~/forge-local-docs/orbit-babo/prompt.txt first',
      'the box path ~/forge-local-docs/orbit-babo/prompt.txt',
    ],
    ['Signs with id_ed25519', 'the key id_ed25519'],
    ['Calls the admin API with orbit_admin.pem', 'the key orbit_admin.pem'],
    ['Reads the token from credentials.json', 'the credential file credentials.json'],
    ['Types the request into the master’s tmux pane', 'the shell tmux'],
    ['Tails the deploy log over ssh', 'the shell ssh'],
    ['Reads the capability list off 10.0.4.12', 'the host 10.0.4.12'],
    ['Watches orbit-prod.sidcorp.co after a merge', 'the host orbit-prod.sidcorp.co'],
  ])('names what %j reaches', (text, found) => {
    expect(boxReachIn(text)).toBe(found);
  });

  it.each([
    'Files the confirmed request on project orbit before work',
    'Says what Orbit can do from its document and knowledge, or cannot tell',
    'Reaches production only through Forge’s deploy door, else files it',
    'Reads the deployment record after a merge',
    'Branch, commit, push, pull request into main, tests first',
    'Uses support.record, support.deploy and config.get',
    'Replies in the thread, in the writer’s language, short',
    'Reads and explains Orbit code, config, docs and history, citing paths',
  ])('passes a duty worded as a Forge door: %j', (text) => {
    expect(boxReachIn(text)).toBeNull();
  });
});
