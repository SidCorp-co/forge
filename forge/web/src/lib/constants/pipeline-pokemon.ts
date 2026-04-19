/** Pokémon evolution chain mapping for pipeline skills/steps — Showdown sprites */

const SHOWDOWN_BASE = 'https://play.pokemonshowdown.com/sprites';

interface PokemonChain {
  /** Evolution chain slugs from baby → final form */
  chain: string[];
}

// Gen 1 only — all chains evolve within the original 151
export const PIPELINE_POKEMON: Record<string, PokemonChain> = {
  'forge-triage':   { chain: ['abra', 'kadabra', 'alakazam'] },
  'forge-clarify':  { chain: ['psyduck', 'golduck'] },
  'forge-plan':     { chain: ['bulbasaur', 'ivysaur', 'venusaur'] },
  'forge-code':     { chain: ['squirtle', 'wartortle', 'blastoise'] },
  'forge-review':   { chain: ['diglett', 'dugtrio'] },
  'forge-test':     { chain: ['charmander', 'charmeleon', 'charizard'] },
  'forge-fix':      { chain: ['pidgey', 'pidgeotto', 'pidgeot'] },
  'forge-release':  { chain: ['chansey'] },
};

// Step key (settings) → skill name mapping
const STEP_TO_SKILL: Record<string, string> = {
  autoTriage:  'forge-triage',
  autoClarify: 'forge-clarify',
  autoPlan:    'forge-plan',
  autoCode:    'forge-code',
  autoReview:  'forge-review',
  autoTest:    'forge-test',
  autoFix:     'forge-fix',
  autoRelease: 'forge-release',
};

/** Pikachu evolution line for active task count indicator */
const PIKACHU_CHAIN = ['pichu', 'pikachu', 'raichu'];

export function getActiveCountSprite(activeCount: number): { url: string; name: string } {
  let slug: string;
  if (activeCount <= 5) slug = PIKACHU_CHAIN[0];
  else if (activeCount <= 10) slug = PIKACHU_CHAIN[1];
  else slug = PIKACHU_CHAIN[2];
  return {
    url: `${SHOWDOWN_BASE}/ani/${slug}.gif`,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
  };
}

export function spriteUrl(slug: string, pose: 'front' | 'back' = 'front'): string {
  const folder = pose === 'back' ? 'ani-back' : 'ani';
  return `${SHOWDOWN_BASE}/${folder}/${slug}.gif`;
}

/** Get the first (baby) form sprite — back view (waiting/queued) */
export function getPokemonSprite(skill: string): string | null {
  const pokemon = PIPELINE_POKEMON[skill];
  if (!pokemon) return null;
  return spriteUrl(pokemon.chain[0], 'back');
}

/** Get the full evolution chain — front view only (running/fighting) */
export function getPokemonChain(skill: string): { url: string; name: string }[] | null {
  const pokemon = PIPELINE_POKEMON[skill];
  if (!pokemon) return null;
  return pokemon.chain.map((slug) => ({
    url: spriteUrl(slug, 'front'),
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
  }));
}

/** Get display name (final form) */
export function getPokemonName(skill: string): string | null {
  const pokemon = PIPELINE_POKEMON[skill];
  if (!pokemon) return null;
  const final = pokemon.chain[pokemon.chain.length - 1];
  return final.charAt(0).toUpperCase() + final.slice(1);
}

export function getPokemonForStep(stepKey: string): { name: string; sprite: string } | null {
  const skill = STEP_TO_SKILL[stepKey];
  if (!skill) return null;
  const pokemon = PIPELINE_POKEMON[skill];
  if (!pokemon) return null;
  const final = pokemon.chain[pokemon.chain.length - 1];
  return {
    name: final.charAt(0).toUpperCase() + final.slice(1),
    sprite: spriteUrl(pokemon.chain[0]),
  };
}
