import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * pdfmuse.db 统一连接工厂：主进程各模块分别持连接写同一个库文件，pragma 在此集中设置——
 * WAL（库级持久化，首个连接设一次即全局生效）、busy_timeout（同步 API 下跨连接写竞争
 * 等待而非立即抛 SQLITE_BUSY；当前事务都不跨 await，属对外部并发与未来演进的廉价保险）、
 * foreign_keys（此前仅部分连接开启，统一为全开）。新模块一律经此打开，不再自建。
 */
export function openPdfMuseDatabase(dataHome: string): DatabaseSync {
  const database = new DatabaseSync(path.join(dataHome, "pdfmuse.db"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  return database;
}
