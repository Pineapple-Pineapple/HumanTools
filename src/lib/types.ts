export interface Block {
  id: string;
  text: string;
}

export interface PageLink {
  href: string;
  text: string;
}

export interface PageModel {
  url: string;
  blocks: Block[];
  links: PageLink[];
}

export type Grade = 6 | 8 | 10 | 12;

export type Provider = "openai" | "openrouter";

export type RewriteFormat = "prose" | "bullets";
