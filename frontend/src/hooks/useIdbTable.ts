/**
 * useIdbTable：Dexie 单表增删改查 + 响应式订阅封装（React Hook）。
 * 内部用订阅 + useState 暴露响应式数据，被全部页面消费；
 * 页面统一通过它读写 IndexedDB，避免组件内部直接触碰 Dexie 实例。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery, type Table } from 'dexie';
import { createId, db } from '@/utils/db';

/** 所有持久化实体的公共字段 */
export interface IdbRecord {
  id: string;
  createdAt?: number;
  updatedAt?: number;
}

/** 新增记录入参：id 与时间戳由封装层补齐 */
export type NewRecord<T extends IdbRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
};

export interface UseIdbTableOptions<T extends IdbRecord> {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean;
  /** 数据变化后的额外回调 */
  onChange?: (rows: T[]) => void;
}

export interface UseIdbTableResult<T extends IdbRecord> {
  rows: T[];
  /** 是否已完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  stop: () => void;
  getById: (id: string) => Promise<T | undefined>;
  list: () => Promise<T[]>;
  create: (payload: NewRecord<T>, idPrefix?: string) => Promise<T>;
  update: (id: string, patch: Partial<T>) => Promise<void>;
  upsert: (row: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bulkRemove: (ids: string[]) => Promise<void>;
  bulkPut: (list: T[]) => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * @param tableSelector 从 Dexie 实例取表的函数，例如 (database) => database.arrays
 */
export function useIdbTable<T extends IdbRecord>(
  tableSelector: (database: typeof db) => Table<T, string>,
  options: UseIdbTableOptions<T> = {}
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true, onChange } = options;
  const [rows, setRows] = useState<T[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const tableRef = useRef(tableSelector(db));
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  const applySort = useCallback(
    (list: T[]): T[] => {
      if (!sortByUpdatedAt) return [...list];
      return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },
    [sortByUpdatedAt]
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const list = applySort(await tableRef.current.toArray());
      setRows(list);
      setReady(true);
      setError(null);
      onChangeRef.current?.(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取本地数据失败');
    } finally {
      setLoading(false);
    }
  }, [applySort]);

  useEffect(() => {
    const table = tableRef.current;
    const observable = liveQuery(async () => applySort(await table.toArray()));
    subscriptionRef.current = observable.subscribe({
      next: (list: T[]) => {
        setRows(list);
        setReady(true);
        setError(null);
        onChangeRef.current?.(list);
      },
      error: (err: unknown) => {
        setError(err instanceof Error ? err.message : '订阅本地数据失败');
      },
    });
    void refresh();
    return () => {
      subscriptionRef.current?.unsubscribe();
      subscriptionRef.current = null;
    };
  }, [applySort, refresh]);

  const stop = useCallback((): void => {
    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = null;
  }, []);

  const create = useCallback(async (payload: NewRecord<T>, idPrefix = 'row'): Promise<T> => {
    const now = Date.now();
    const record = {
      ...(payload as object),
      id: payload.id ?? createId(idPrefix),
      createdAt: payload.createdAt ?? now,
      updatedAt: payload.updatedAt ?? now,
    } as T;
    await tableRef.current.put(record);
    return record;
  }, []);

  const update = useCallback(async (id: string, patch: Partial<T>): Promise<void> => {
    await tableRef.current.update(id, { ...patch, updatedAt: Date.now() } as never);
  }, []);

  const upsert = useCallback(async (row: T): Promise<void> => {
    await tableRef.current.put({ ...row, updatedAt: Date.now() } as T);
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    await tableRef.current.delete(id);
  }, []);

  const bulkRemove = useCallback(async (ids: string[]): Promise<void> => {
    await tableRef.current.bulkDelete(ids);
  }, []);

  const bulkPut = useCallback(async (list: T[]): Promise<void> => {
    await tableRef.current.bulkPut(list);
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    await tableRef.current.clear();
  }, []);

  return {
    rows,
    ready,
    loading,
    error,
    refresh,
    stop,
    getById: (id: string) => tableRef.current.get(id),
    list: () => tableRef.current.toArray(),
    create,
    update,
    upsert,
    remove,
    bulkRemove,
    bulkPut,
    clear,
  };
}
