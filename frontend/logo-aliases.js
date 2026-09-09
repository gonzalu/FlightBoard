/*
 * Which logo to draw for a callsign prefix, when it isn't its own.
 *
 * Regional carriers fly in their mainline partner's livery, so the tail you
 * actually see belongs to the partner, not the operator whose callsign is on
 * the radio. This is also the place to redirect any airline whose own artwork
 * doesn't survive the reduction to a 26px square (tools/make_logos.py rejects
 * thin wordmarks rather than drawing noise).
 *
 * Only unambiguous mappings belong here. Republic (RPA), SkyWest (SKW), Mesa
 * (ASH) and GoJet (GJS) fly for several mainlines simultaneously, so their tail
 * depends on the individual airframe and can't be derived from the callsign.
 *
 * Curated by hand, unlike logos.js which is generated - add to it freely.
 */
const LOGO_ALIASES = {
  // EDV (Endeavor) now has its own mark, cropped from the swoosh - see CROPS
  // in tools/make_logos.py. Alias it to DAL if you'd rather see Delta's widget,
  // which is what its aircraft are actually painted in.
  ENY: 'AAL',   // Envoy Air        - American Eagle only
  JIA: 'AAL',   // PSA Airlines     - American Eagle only
  PDT: 'AAL',   // Piedmont         - American Eagle only
};
