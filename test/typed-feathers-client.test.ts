import test from 'ava'
import { dirname, join } from 'path'
import * as ts from 'typescript'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, 'fixtures', 'typed-feathers-client.ts')

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

function getTypeAtPosition(
  filePath: string,
  exportName: string,
  tsConfigOptions: ts.CompilerOptions = {},
): string {
  const { checker, sourceFile } = getProgramAndChecker(filePath, tsConfigOptions)

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
          const declaration = node.declarationList.declarations.find(
            decl => ts.isIdentifier(decl.name) && decl.name.text === exportName,
          )
          if (declaration) return declaration
        } else if (ts.isTypeAliasDeclaration(node)) {
          if (ts.isIdentifier(node.name) && node.name.text === exportName) return node
        }
      }
    }

    return ts.forEachChild(node, findExport)
  }

  const exportNode = findExport(sourceFile)
  if (!exportNode) throw new Error(`Export "${exportName}" not found`)

  const type = checker.getTypeAtLocation(exportNode)
  return checker.typeToString(type, exportNode, ts.TypeFormatFlags.NoTruncation)
}

// ========================================
// CRUD method type tests
// ========================================

test('typed feathers client - get returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesGetResult')
  t.is(type, 'Note')
})

test('typed feathers client - find returns Note array or paginated', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesFindResult')
  // find can return either an array or a paginated result
  t.true(
    type.includes('Note[]') || type.includes('data: Note[]'),
    `Expected find to return Note[] or paginated result, got: ${type}`,
  )
})

test('typed feathers client - create returns Note or Note[]', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesCreateResult')
  // create can return Note or Note[] depending on overload
  t.true(
    type === 'Note' || type === 'Note[]' || type === 'Note | Note[]',
    `Expected Note, Note[], or Note | Note[], got: ${type}`,
  )
})

test('typed feathers client - update returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesUpdateResult')
  t.is(type, 'Note')
})

test('typed feathers client - patch returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesPatchResult')
  t.is(type, 'Note')
})

test('typed feathers client - remove returns Note', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesRemoveResult')
  t.is(type, 'Note')
})

// ========================================
// Custom methods tests
// ========================================

test('typed feathers client - archive custom method returns correct type', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesArchiveResult')
  t.is(type, '{ count: number; }')
})

test('typed feathers client - search custom method returns correct type', t => {
  const type = getTypeAtPosition(fixturePath, 'NotesSearchResult')
  t.is(type, 'Note[]')
})

// ========================================
// Service type narrowing tests
// ========================================

test('typed feathers client - tasks service returns Task type', t => {
  const type = getTypeAtPosition(fixturePath, 'TasksGetResult')
  t.is(type, 'Task')
})

test('typed feathers client - service types are correctly narrowed and distinct', t => {
  const notesType = getTypeAtPosition(fixturePath, 'NotesServiceType')
  const tasksType = getTypeAtPosition(fixturePath, 'TasksServiceType')

  // Types should be different - each service should have its own typed methods
  t.not(notesType, tasksType, 'Notes and Tasks service types should be distinct')

  // Notes service should include Note type
  t.true(notesType.includes('Note'), `Notes service type should include Note, got: ${notesType}`)

  // Tasks service should include Task type
  t.true(tasksType.includes('Task'), `Tasks service type should include Task, got: ${tasksType}`)
})
