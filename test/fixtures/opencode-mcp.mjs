import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync } from 'node:fs';
if (process.argv[3]) appendFileSync(process.argv[3], JSON.stringify({
  value: process.env.BORG_FIXTURE_VALUE, file: process.env.BORG_FIXTURE_FILE,
  rootPasswordPresent: Boolean(process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD),
}) + '\n');
const server = new Server({name:'borg.native-fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
  {name:'borg_read-log',description:'Read a compact local fixture log.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'borg_roster',description:'Read the local fixture roster.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
]}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  appendFileSync(process.argv[2], JSON.stringify({name:request.params.name,meta:request.params._meta})+'\n');
  return {content:[{type:'text',text:request.params.name==='read-log'?'fixture log':'fixture drone'}]};
});
await server.connect(new StdioServerTransport());
