import test from 'ava'
import { dirname, join } from 'path'
import * as ts from 'typescript'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Helper to get type at a specific position in a TypeScript file
function getTypeAtPosition(
  filePath: string,
  exportName: string,
  tsConfigOptions: ts.CompilerOptions = {},
): string {
  // Create a TypeScript program with the fixture file
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
    'import("/Users/karolis/projects/figbird/lib/index").Service<Person, Record<string, unknown>, Record<string, never>, "api/people">',
  )
  t.is(serviceItemType, 'Person')
  t.is(peopleType, 'import("/Users/karolis/projects/figbird/lib/index").QueryResult<Person[]>')
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
    'import("/Users/karolis/projects/figbird/lib/index").Service<Person, Record<string, unknown>, Record<string, never>, "api/people">',
  )
  t.is(
    taskServiceType,
    'import("/Users/karolis/projects/figbird/lib/index").Service<Task, Record<string, unknown>, Record<string, never>, "api/tasks">',
  )

  // Test that ServiceItem extraction is working
  t.is(personItemType, 'Person')
  t.is(taskItemType, 'Task')

  // Test that useFind correctly narrows to specific types (no more unions!)
  t.is(peopleType, 'import("/Users/karolis/projects/figbird/lib/index").QueryResult<Person[]>')
  t.is(tasksType, 'import("/Users/karolis/projects/figbird/lib/index").QueryResult<Task[]>')

  // Verify type narrowing - ensure services don't cross-contaminate
  t.not(peopleType, tasksType, 'People and tasks should have different types')
  t.not(personItemType, taskItemType, 'Person and Task item types should be distinct')
})
