// Text set into a page core writes itself (a preview host's refusal, the owner's sign-in landing):
// each character HTML reads as markup or as an attribute's end becomes its numeric reference.

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
