// Championship mode: a series of 3 races with accumulated points.
// Points awarded: 1st=10, 2nd=7, 3rd=5, 4th=3 (extra places get 1).

export const POINTS_TABLE = [10, 7, 5, 3, 1];

export interface ChampionshipDef {
  name: string;
  emoji: string;
  tracks: string[];  // track names matching TRACK_OPTIONS in main.ts
}

export const CHAMPIONSHIPS: ChampionshipDef[] = [
  { name: "Snow Cup",    emoji: "❄️",  tracks: ["race",    "snow2",  "snow3"]        },
  { name: "Country Cup", emoji: "🌿",  tracks: ["country", "flood",  "river"]        },
  { name: "City Cup",    emoji: "🏙️", tracks: ["be",      "city3",  "tiny-sur-mer"] },
];

export interface RacerStanding {
  name: string;
  racerIdx: number;
  points: number;
  raceResults: number[]; // finish position (0=1st) per race
}

export class ChampionshipRunner {
  raceIdx = 0;
  standings: RacerStanding[];

  constructor(
    public readonly def: ChampionshipDef,
    racerNames: string[],  // ordered by racer index (player first)
  ) {
    this.standings = racerNames.map((name, i) => ({
      name,
      racerIdx: i,
      points: 0,
      raceResults: [],
    }));
  }

  get currentTrack(): string {
    return this.def.tracks[this.raceIdx];
  }

  get totalRaces(): number {
    return this.def.tracks.length;
  }

  get isComplete(): boolean {
    return this.raceIdx >= this.totalRaces;
  }

  /** Call after each race with final rankings (array of racer indices in finish order). */
  recordResult(finishOrder: number[]) {
    for (let pos = 0; pos < finishOrder.length; pos++) {
      const ri = finishOrder[pos];
      const pts = POINTS_TABLE[pos] ?? 1;
      this.standings[ri].points += pts;
      this.standings[ri].raceResults.push(pos);
    }
    this.raceIdx++;
  }

  /** Returns standings sorted by points (descending). */
  getSortedStandings(): RacerStanding[] {
    return [...this.standings].sort((a, b) => b.points - a.points);
  }

  /** Returns true if the championship just finished (raceIdx === totalRaces). */
  get justFinished(): boolean {
    return this.raceIdx === this.totalRaces;
  }
}
