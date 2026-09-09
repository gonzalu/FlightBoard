/*
 * Brand colours by ICAO airline prefix, as [base, accent].
 *
 * These are colours, not artwork: the pair drives the generated tail fin a
 * carrier gets when it has no logo, and the accent is also what a wordmark in
 * wordmarks.js is drawn in. Anything not listed falls back to a hash of the
 * airline's name, which is stable per carrier but arbitrary.
 *
 * Curated by hand. Lives here rather than in panel.js so that /logos.html can
 * draw a wordmark in the same colour the panel would.
 */
const AIRLINE_COLORS = {
  UAL: [0x1a3a8f, 0x4aa3ff], AAL: [0x8c99a6, 0xd42b3a], DAL: [0x0b2c5c, 0xc8102e],
  SWA: [0x1d3d78, 0xf9b612], JBU: [0x143d7a, 0x39a3ff], ASA: [0x0b3b5c, 0x2ec4b6],
  NKS: [0x2a2a2a, 0xffe600], FFT: [0x0b5c3b, 0x39d98a], RPA: [0x1f4e79, 0x8fb8de],
  EDV: [0x0b2c5c, 0xc8102e], SKW: [0x2b4a6f, 0x9ab8d6], ENY: [0x8c99a6, 0xd42b3a],
  ASH: [0x1f4e79, 0x8fb8de], UPS: [0x3b2314, 0xc8a165], FDX: [0x4d148c, 0xff6600],
  GTI: [0x1f3b6b, 0x6f9fd8], BAW: [0x1d3557, 0xc8102e], DLH: [0x14202e, 0xf9b612],
  AFR: [0x102a54, 0xc8102e], KLM: [0x1a5fa8, 0x7fc4ff], VIR: [0x6b1030, 0xff3f6f],
  ACA: [0x8c1220, 0xff5a6a], JAL: [0x8c1220, 0xff4a5a], ANA: [0x123a6b, 0x5fa8ff],
  UAE: [0x1d3557, 0xd4af37], EJA: [0x1a2b44, 0xc9a227], KAL: [0x1a4f8f, 0x6fb7ff],
  ELY: [0x123a6b, 0x4a90d9], THY: [0x8c1220, 0xe03a4a], QTR: [0x5c0632, 0xa81f5c],
  IBE: [0x8c1220, 0xf2b705], SWR: [0x8c1220, 0xff5a6a], EIN: [0x0b5c3b, 0x39d98a],
  AMX: [0x0b2c5c, 0xe03a4a], AVA: [0x8c1220, 0xe03a4a], CMP: [0x123a6b, 0x5fa8ff],
  ITY: [0x0b3b5c, 0x2ec4b6], LOT: [0x123a6b, 0x5fa8ff], SVA: [0x0b5c3b, 0x39d98a],
};
