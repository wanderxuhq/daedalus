import { createContext, useContext } from 'solid-js';

/** 展开状态集合：tool call 用 id，thinking 用 `thinking-{index}`。 */
export type ExpandedSet = Set<string>;
export const ExpandedContext = createContext<ExpandedSet>(new Set<string>());
export const useExpanded = () => useContext(ExpandedContext);
