import test from 'ava'
import { dirname, join } from 'path'
import * as ts from 'typescript'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const programCache: Map<
  string,
  { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
> = new Map()

function getProgramAndChecker(filePath: string, tsConfigOptions: ts.CompilerOptions = {}) {
  const cacheKey = JSON.stringify({ filePath, tsConfigOptions })
  if (programCache.has(cacheKey)) {
    return programCache.get(cacheKey)!
  }

  const program = ts.createProgram([filePath], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    skipLibCheck: true,
    ...tsConfigOptions,
  })

  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) throw new Error(`Source file not found: ${filePath}`)

  const checker = program.getTypeChecker()
  const cacheEntry = { program, checker, sourceFile }
  programCache.set(cacheKey, cacheEntry)
  return cacheEntry
}

// Helper to get type at a specific position in a TypeScript file
function getTypeAtPosition(
  filePath: string,
  exportName: string,
  tsConfigOptions: ts.CompilerOptions = {},
): string {
  const { checker, sourceFile } = getProgramAndChecker(filePath, tsConfigOptions)

  // Find the exported symbol by walking through the source file
  function findExport(node: ts.Node): ts.Node | undefined {
    if (
      ts.isExportDeclaration(node) ||
      ts.isVariableStatement(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      const modifiers = ts.getModifiers(node)
      const hasExportModifier = modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)

      if (hasExportModifier) {
        if (ts.isVariableStatement(node)) {
          // Handle export const/let/var
          const declaration = node.declarationList.declarations.find(
            decl => ts.isIdentifier(decl.name) && decl.name.text === exportName,
          )
          if (declaration) return declaration
        } else if (ts.isTypeAliasDeclaration(node)) {
          // Handle export type
          if (ts.isIdentifier(node.name) && node.name.text === exportName) return node
        }
      }
    }

    return ts.forEachChild(node, findExport)
  }

  const exportNode = findExport(sourceFile)
  if (!exportNode) throw new Error(`Export "${exportName}" not found`)

  // Get the type at this node
  const type = checker.getTypeAtLocation(exportNode)
  return checker.typeToString(type, exportNode, ts.TypeFormatFlags.NoTruncation)
}

test('useFind returns correct type for Person service', t => {
  const fixturePath = join(__dirname, 'fixtures', 'basic-schema-inference.ts')

  const serviceByNameType = getTypeAtPosition(fixturePath, 'DebugServiceByName')
  const serviceItemType = getTypeAtPosition(fixturePath, 'DebugServiceItem')
  const peopleType = getTypeAtPosition(fixturePath, 'people')

  t.is(
    serviceByNameType,
    'import("/Users/karolis/projects/figbird/lib/index").Service<Person, Record<string, unknown>, "api/people">',
  )
  t.is(serviceItemType, 'Person')
  t.is(
    peopleType,
    'import("/Users/karolis/projects/figbird/lib/index").QueryResult<Person[], import("/Users/karolis/projects/figbird/lib/index").FindMeta>',
  )
})

test('type narrowing works correctly with multiple services', t => {
  const fixturePath = join(__dirname, 'fixtures', 'multi-service-inference.ts')

  // Check Person service types
  const personServiceType = getTypeAtPosition(fixturePath, 'PersonServiceByName')
  const personItemType = getTypeAtPosition(fixturePath, 'PersonServiceItem')
  const peopleType = getTypeAtPosition(fixturePath, 'people')

  // Check Task service types
  const taskServiceType = getTypeAtPosition(fixturePath, 'TaskServiceByName')
  const taskItemType = getTypeAtPosition(fixturePath, 'TaskServiceItem')
  const tasksType = getTypeAtPosition(fixturePath, 'tasks')

  // Test that the key types are working correctly
  t.is(
    personServiceType,
    'import("/Users/karolis/projects/figbird/lib/index").Service<Person, Record<string, unknown>, "api/people">',
  )
  t.is(
    taskServiceType,
    'import("/Users/karolis/projects/figbird/lib/index").Service<Task, Record<string, unknown>, "api/tasks">',
  )

  // Test that ServiceItem extraction is working
  t.is(personItemType, 'Person')
  t.is(taskItemType, 'Task')

  // Test that useFind correctly narrows to specific types (no more unions!)
  t.is(
    peopleType,
    'import("/Users/karolis/projects/figbird/lib/index").QueryResult<Person[], import("/Users/karolis/projects/figbird/lib/index").FindMeta>',
  )
  t.is(
    tasksType,
    'import("/Users/karolis/projects/figbird/lib/index").QueryResult<Task[], import("/Users/karolis/projects/figbird/lib/index").FindMeta>',
  )

  // Verify type narrowing - ensure services don't cross-contaminate
  t.not(peopleType, tasksType, 'People and tasks should have different types')
  t.not(personItemType, taskItemType, 'Person and Task item types should be distinct')
})

test('FindMeta type inference works correctly', t => {
  const fixturePath = join(__dirname, 'fixtures', 'feathers-meta-inference.ts')

  // Check that find result has FindMeta type for meta
  const findMetaType = getTypeAtPosition(fixturePath, 'FindMetaType')
  const findMetaTotal = getTypeAtPosition(fixturePath, 'FindMetaTotal')
  const findMetaLimit = getTypeAtPosition(fixturePath, 'FindMetaLimit')
  const findMetaSkip = getTypeAtPosition(fixturePath, 'FindMetaSkip')

  // useGet no longer exposes meta by default

  // Check the actual property types
  const metaTotalType = getTypeAtPosition(fixturePath, 'MetaTotalType')
  const metaLimitType = getTypeAtPosition(fixturePath, 'MetaLimitType')
  const metaSkipType = getTypeAtPosition(fixturePath, 'MetaSkipType')

  // Verify that find meta has the FindMeta type
  t.is(findMetaType, 'import("/Users/karolis/projects/figbird/lib/index").FindMeta')

  // Verify that individual properties have the correct types
  t.is(findMetaTotal, 'number')
  t.is(findMetaLimit, 'number')
  t.is(findMetaSkip, 'number')

  // Verify that accessing properties gives the right types
  t.is(metaTotalType, 'number')
  t.is(metaLimitType, 'number')
  t.is(metaSkipType, 'number')
})

test('meta type is automatically inferred from Figbird instance', t => {
  const fixturePath = join(__dirname, 'fixtures', 'inferred-meta-from-figbird.ts')

  // Check that data types are correct
  const tasksDataType = getTypeAtPosition(fixturePath, 'TasksData')
  const projectDataType = getTypeAtPosition(fixturePath, 'ProjectData')

  // Check that meta types are automatically inferred as FindMeta
  const tasksMetaType = getTypeAtPosition(fixturePath, 'TasksMeta')
  // get no longer exposes meta by default

  // Check individual meta properties
  const tasksMetaTotalType = getTypeAtPosition(fixturePath, 'TasksMetaTotal')
  const tasksMetaLimitType = getTypeAtPosition(fixturePath, 'TasksMetaLimit')
  const tasksMetaSkipType = getTypeAtPosition(fixturePath, 'TasksMetaSkip')

  // Check backward compatibility
  const backwardCompatMetaType = getTypeAtPosition(fixturePath, 'BackwardCompatMeta')

  // Verify data types
  t.is(tasksDataType, 'Task[] | null')
  t.is(projectDataType, 'Project | null')

  // Verify that meta is automatically inferred as FindMeta for find
  // without having to pass it explicitly to createHooks
  t.is(tasksMetaType, 'import("/Users/karolis/projects/figbird/lib/index").FindMeta')

  // Verify individual meta properties are typed correctly
  t.is(tasksMetaTotalType, 'number')
  t.is(tasksMetaLimitType, 'number')
  t.is(tasksMetaSkipType, 'number')

  // Verify that meta type is always inferred from the adapter (FindMeta in this case)
  t.is(backwardCompatMetaType, 'import("/Users/karolis/projects/figbird/lib/index").FindMeta')
})

test('combined params includes both QueryConfig and FeathersParams', t => {
  const fixturePath = join(__dirname, 'fixtures', 'params-type-inference.ts')

  // Check that combined params type includes both Figbird and adapter params
  const combinedParamsType = getTypeAtPosition(fixturePath, 'testCombinedParams')

  // Should include FeathersParams properties
  t.true(
    combinedParamsType.includes('query') || combinedParamsType.includes('FeathersParams'),
    `Expected combined params to include FeathersParams properties, got: ${combinedParamsType}`,
  )

  // Check that specific QueryConfig properties are present in the type
  const hasQueryConfig =
    combinedParamsType.includes('skip') ||
    combinedParamsType.includes('realtime') ||
    combinedParamsType.includes('fetchPolicy') ||
    combinedParamsType.includes('QueryConfig')

  t.true(
    hasQueryConfig,
    `Expected combined params to include QueryConfig properties, got: ${combinedParamsType}`,
  )

  // Verify complex query accepts all combined param types
  const complexQueryType = getTypeAtPosition(fixturePath, 'complexQuery')
  t.true(
    complexQueryType.includes('QueryResult'),
    `Expected complexQuery to return QueryResult, got: ${complexQueryType}`,
  )
})

test('Figbird methods infer types from schema (query, subscribe, mutate)', t => {
  const fixturePath = join(__dirname, 'fixtures', 'figbird-methods-inference.ts')

  const findSubscribeStateType = getTypeAtPosition(fixturePath, 'FindSubscribeState')
  const getSubscribeStateType = getTypeAtPosition(fixturePath, 'GetSubscribeState')
  const createResultType = getTypeAtPosition(fixturePath, 'CreateResult')

  // Query subscribe param should carry QueryState with inferred data + Feathers meta
  t.is(
    findSubscribeStateType,
    'import("/Users/karolis/projects/figbird/lib/index").QueryState<Person[], import("/Users/karolis/projects/figbird/lib/index").FindMeta>',
  )
  t.is(
    getSubscribeStateType,
    'import("/Users/karolis/projects/figbird/lib/index").QueryState<Person, import("/Users/karolis/projects/figbird/lib/index").FindMeta>',
  )

  // Mutate create should resolve to Person
  t.is(createResultType, 'Person')
})
