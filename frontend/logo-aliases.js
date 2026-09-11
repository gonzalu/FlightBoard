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
  NJE: 'EJA',   // NetJets Europe   - same brand, same livery as NetJets. Its
                //                    radarbox artwork is byte-identical, and
                //                    EJA's mark comes from tools/fetch_logo_art.py
  ENY: 'AAL',   // Envoy Air        - American Eagle only
  JIA: 'AAL',   // PSA Airlines     - American Eagle only
  PDT: 'AAL',   // Piedmont         - American Eagle only
};

/*
 * Logos for operators that aren't airlines.
 *
 * Police, air ambulance, tour and survey operators fly aircraft whose callsign
 * is just a registration, so there is no ICAO prefix to key a logo off and no
 * entry in any airline archive either. What there *is*, now that the backend
 * asks hexdb, is a registered owner's name. Map a piece of that name to a code,
 * drop matching artwork into your logo source directory as <CODE>.png, and the
 * board draws it.
 *
 *   'NEW YORK CITY POLICE': 'NYPD'    with logo-sources/custom/NYPD.png
 *
 * Matched as an uppercase substring of the owner, so a partial name is enough
 * and spelling variations further along don't matter. The longest matching
 * entry wins, which is how a specific operator can sit alongside a general one.
 * Keep entries long enough to be unambiguous: 'POLICE' alone would collect
 * every force in the country under one badge.
 *
 * Operators that DO have an ICAO code need nothing here. hexdb reports it and
 * the normal logo lookup takes over, which is how a NetJets bizjet flying as
 * N741QS gets the NetJets mark.
 */
const OPERATOR_LOGOS = {
  // Add your own. Nothing ships here, because which operators fly over you is
  // the one thing this project can't guess.
};
