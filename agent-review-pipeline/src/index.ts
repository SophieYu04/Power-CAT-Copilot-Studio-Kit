import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseCSZip, zipBotToMetadata } from './parser/csZipParser.js';
import { StageAService } from './analysis/StageAService.js';

const { values } = parseArgs({
  options: {
    zip: { type: 'string' },
    output: { type: 'string', default: 'stdout' },
  },
});

if (!values.zip) {
  console.error('Usage: node dist/index.js --zip <path-to-solution.zip>');
  process.exit(1);
}

const zipBuffer = readFileSync(values.zip);
const { bots, componentsBySchemaName, diagnostics } = await parseCSZip(zipBuffer);

// Safe aggregate diagnostics: do not print ZIP paths, instructions, or secrets.
console.error(`[Stage A diagnostics] ZIP entries: ${diagnostics.zipEntryCount}`);
console.error(`[Stage A diagnostics] Top-level entries: ${diagnostics.topLevelEntries.join(', ') || '(none)'}`);
console.error(`[Stage A diagnostics] bot.xml files: ${diagnostics.botXmlCount}`);
console.error(`[Stage A diagnostics] botcomponent.xml files: ${diagnostics.botComponentXmlCount}`);
console.error(`[Stage A diagnostics] botcomponent data files: ${diagnostics.botDataCount}`);
console.error(`[Stage A diagnostics] bots parsed: ${bots.length}`);

const parsedComponents = Object.values(componentsBySchemaName).flat();
const componentTypeCounts = new Map<string, number>();
for (const component of parsedComponents) {
  componentTypeCounts.set(
    component.componenttype,
    (componentTypeCounts.get(component.componenttype) || 0) + 1,
  );
}
const componentTypeSummary = [...componentTypeCounts.entries()]
  .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
  .map(([type, count]) => `${type}:${count}`)
  .join(', ');
console.error(`[Stage A diagnostics] components parsed: ${parsedComponents.length}`);
console.error(`[Stage A diagnostics] component types: ${componentTypeSummary || '(none)'}`);

// Print only classification metadata, never component names or YAML content.
parsedComponents.forEach((component, index) => {
  const payload = component.data || component.content || '';
  const yamlKind = /^\s*kind\s*:\s*([A-Za-z0-9_.-]+)/m.exec(payload)?.[1] || '(none)';
  console.error(
    `[Stage A diagnostics] component ${index + 1}: type=${component.componenttype}, `
      + `payload characters=${payload.length}, YAML kind=${yamlKind}`,
  );
});

const stageAService = new StageAService();
const results = [];

// Evaluate every agent found in the solution ZIP.
// Do not exclude modern Copilot Studio agents that lack
// settings.GenerativeActionsEnabled.
for (const bot of bots) {
  const components = componentsBySchemaName[bot.schemaName] || [];
  const metadata = zipBotToMetadata(bot);
  const result = await stageAService.executeStageAFromData(
    { botId: metadata.botId, name: metadata.name, description: bot.description },
    components,
  );
  results.push(result);
}

const topicComponentCount = results.reduce(
  (total, result) => total + (result.topicComponents?.length || 0),
  0,
);
const instructionCharacterCount = results.reduce(
  (total, result) => total + (result.agentInstructions?.length || 0),
  0,
);
console.error(`[Stage A diagnostics] topic components: ${topicComponentCount}`);
console.error(`[Stage A diagnostics] instruction characters: ${instructionCharacterCount}`);

const output = JSON.stringify(results.length === 1 ? results[0] : results, null, 2);

if (values.output && values.output !== 'stdout') {
  writeFileSync(values.output, output);
  console.error(`Stage A output written to ${values.output}`);
} else {
  console.log(output);
}
