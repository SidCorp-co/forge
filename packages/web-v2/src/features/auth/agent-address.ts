export const AGENT_EMAIL_DOMAIN = "agents.forge.invalid";

export const AGENT_ADDRESS_MESSAGE =
  "That address belongs to an agent account Forge runs, and no person signs up or signs in with it. Use an address you receive mail at.";

export function isAgentAddress(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`);
}
