export interface PIFeed {
  id: number;
  feedUrl: string;
  title: string;
  image: string;
  description: string;
  author: string;
  url: string; // Podcast Index web page URL
}

export interface PIEpisode {
  id: number;
  guid: string;
  feedId: number;
  feedTitle: string;
  feedUrl: string;
  title: string;
  description: string;
  datePublished: number; // Unix timestamp
  duration: number;      // seconds
  enclosureUrl: string;  // direct audio URL
  image: string;
}
