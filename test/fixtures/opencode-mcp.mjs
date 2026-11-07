import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';
import { TOOL_MANIFEST } from '../../dist/tool-manifest.js';
import { normalizeLogAudience } from '../../dist/direct-log.js';
if (process.argv[3]) appendFileSync(process.argv[3], JSON.stringify({
  value: process.env.BORG_FIXTURE_VALUE, file: process.env.BORG_FIXTURE_FILE,
  rootPasswordPresent: Boolean(process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD),
}) + '\n');
const server = new Server({name:'borg.native-fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
  {name:'borg_read_log',description:'Read a compact local fixture log.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'borg_role',description:'Read the fixture role.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'borg_playbook',description:'Read the fixture operating playbook.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'borg_roster',description:'Read the local fixture roster.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  TOOL_MANIFEST.find(tool => tool.name === 'borg_log'),
]}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const audience = request.params.name === 'borg_log' ? normalizeLogAudience(request.params.arguments?.to) : undefined;
  appendFileSync(process.argv[2], JSON.stringify({name:request.params.name,meta:request.params._meta,...(audience === undefined ? {} : { audience })})+'\n');
  if (audience !== undefined) return { content: [{ type: 'text', text: 'fixture audience received' }],
    structuredContent: { suppressed: false, entry: null, recipients: [], unreachable_recipients: [], advisory: null } };
  return {content:[{type:'text',text:request.params.name==='borg_read_log'?'fixture log':'fixture drone'}]};
});
await server.connect(new StdioServerTransport());
