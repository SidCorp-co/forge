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
    [
      'Searches logs with /home/dev/forge/projects/eco-adminhub/bin/hub-logs',
      'the box path /home/dev/forge/projects/eco-adminhub/bin/hub-logs',
    ],
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
    // ISS-871: AdminHub-Support's duties, each through a door the channel agent holds; a read's name is no path
    'Answers AdminHub users in plain Vietnamese, in their own thread, short and with no developer detail',
    'Searches the AdminHub production logs through support.read hub-logs, by a fixed string, a day and a log',
    'Reads AdminHub production data only through support.read hub-data-suppliers, hub-data-po, hub-data-po-stats and hub-data-order',
    'Runs the morning check through support.read morning-check and posts one finding with support.check_result, or none',
    "Takes the owner's request to the AdminHub master as a record (support.record) on the AdminHub project; the master answers in the owner's thread",
    "Asks the owner a master's question in the Catalog-AdminHub room with support.ask_owner naming that Forge question; the answer is recorded on it",
  ])('passes a duty worded as a Forge door: %j', (text) => {
    expect(boxReachIn(text)).toBeNull();
  });
});
