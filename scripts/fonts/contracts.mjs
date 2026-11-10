import { z } from 'zod';

export const FONT_FILE = 'FiraCodeNerdFontMono-Regular.ttf';
export const FONT_URL =
  'https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/FiraCode/Regular/' + FONT_FILE;
export const LICENSE_URL = 'https://raw.githubusercontent.com/tonsky/FiraCode/6.2/LICENSE';

export const fontMetadataSchema = z
  .strictObject({
    family: z
      .literal('FiraCode Nerd Font Mono')
      .describe('The exact monospaced Nerd Font family required by the terminal.'),
    style: z.literal('Regular').describe('The required regular font face.'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('The lowercase SHA-256 digest of the exact font bytes.'),
    copyright: z.string().describe('Distinct copyright notices read from the TrueType name table.'),
  })
  .describe('Verified identity, digest and copyright of the bundled terminal font.');

export const fontSourceSchema = z
  .strictObject({
    file: z.literal(FONT_FILE).describe('The exact terminal font filename.'),
    source: z.literal(FONT_URL).describe('The pinned upstream font download URL.'),
    nerdFonts: z.literal('v3.4.0').describe('The pinned Nerd Fonts release.'),
    firaCode: z.literal('6.2').describe('The upstream Fira Code release.'),
    ...fontMetadataSchema.shape,
  })
  .describe('The FONT-SOURCE.json provenance record written beside the locally provisioned font.');

const inputPathSchema = z
  .string()
  .refine((filename) => {
    return filename.trim().length > 0 && !filename.includes('\0');
  })
  .describe('A nonblank local input path, with no NUL characters; relative paths are resolved locally.');

export const fontInputSchema = z
  .strictObject({
    file: inputPathSchema
      .optional()
      .describe('The exact local Mono-Regular TTF; absent to download the pinned font.'),
    licenseFile: inputPathSchema
      .optional()
      .describe('The local SIL OFL license; absent to download the pinned license.'),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional()
      .describe('An optional SHA-256 digest pin for the input font; uppercase hex is accepted.'),
  })
  .describe('Font CLI and environment configuration checked before reading or downloading inputs.');

export const fontArgumentsSchema = z
  .array(
    z
      .string()
      .regex(/^--(?:file|license)=/)
      .describe('A --file=PATH or --license=PATH font provisioning argument.'),
  )
  .max(2)
  .refine((args) => {
    const names = args.map((argument) => {
      return argument.slice(0, argument.indexOf('='));
    });

    return new Set(names).size === names.length;
  })
  .describe(
    'At most one local font and one local license override; unknown and duplicate options are rejected.',
  );
