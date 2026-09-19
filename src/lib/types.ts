export interface Block {
  id: string;
  text: string;
}

export interface PageModel {
  url: string;
  blocks: Block[];
}

export type Grade = 6 | 9 | 12;
