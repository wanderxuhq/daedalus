import { bashTool } from './bash.ts';
import { readTool } from './read.ts';
import { writeTool } from './write.ts';
import { editTool } from './edit.ts';
import { lsTool } from './ls.ts';
import { grepTool } from './grep.ts';
import { globTool } from './glob.ts';
import type { Tool } from './types.ts';

export const tools: Tool[] = [bashTool, readTool, writeTool, editTool, lsTool, grepTool, globTool];
