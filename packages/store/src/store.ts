import { openDatabase, type Database, type OpenDatabaseOptions } from './db.js';
import { AgentsRepo, SubagentsRepo } from './repos/agents.js';
import { EventsRepo } from './repos/events.js';
import { CustomServersRepo, ExtensionsRepo, ReviewRepo, UiStateRepo, UsageRepo } from './repos/misc.js';
import { ProjectsRepo } from './repos/projects.js';
import { SettingsService } from './settings.js';

/** Every repository over one database. Main creates one at startup: `openStore(join(userData, 'oide.db'))`. */
export interface Store {
  database: Database;
  projects: ProjectsRepo;
  agents: AgentsRepo;
  subagents: SubagentsRepo;
  events: EventsRepo;
  usage: UsageRepo;
  review: ReviewRepo;
  ui: UiStateRepo;
  extensions: ExtensionsRepo;
  customServers: CustomServersRepo;
  settings: SettingsService;
  close(): void;
}

export function createStore(database: Database): Store {
  return {
    database,
    projects: new ProjectsRepo(database),
    agents: new AgentsRepo(database),
    subagents: new SubagentsRepo(database),
    events: new EventsRepo(database),
    usage: new UsageRepo(database),
    review: new ReviewRepo(database),
    ui: new UiStateRepo(database),
    extensions: new ExtensionsRepo(database),
    customServers: new CustomServersRepo(database),
    settings: new SettingsService({ db: database }),
    close: () => database.close(),
  };
}

/** Open (and migrate) the database and build the repositories. Use `':memory:'` in tests. */
export function openStore(file: string, opts?: OpenDatabaseOptions): Store {
  return createStore(openDatabase(file, opts));
}
