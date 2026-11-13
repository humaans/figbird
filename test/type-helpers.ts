import test from 'ava'
import { API, NodeBuilderFlags } from 'typescript/unstable/sync'
import { fileURLToPath } from 'url'

const api = new API({ cwd: fileURLToPath(new URL('../', import.meta.url)) })
test.after.always(() => api.close())

const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
const snapshot = api.updateSnapshot({ openProjects: [configPath] })
const project = snapshot.getProject(configPath)
if (!project) throw new Error(`TypeScript project not found: ${configPath}`)
const { program, checker } = project

export function getTypeAtPosition(filePath: string, exportName: string): string {
  const sourceFile = program.getSourceFile(filePath)
  if (!sourceFile) throw new Error(`Source file not found: ${filePath}`)

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) throw new Error(`Module symbol not found: ${filePath}`)

  const symbol = checker.getExportsOfModule(moduleSymbol).find(symbol => symbol.name === exportName)
  const exportNode = symbol?.declarations[0]?.resolve()
  if (!exportNode) throw new Error(`Export "${exportName}" not found in ${filePath}`)

  const type = checker.getTypeAtLocation(exportNode)
  if (!type || type.isErrorType()) {
    throw new Error(`Type not found for export "${exportName}" in ${filePath}`)
  }

  const raw = checker.typeToString(type, exportNode, NodeBuilderFlags.NoTruncation)
  // Keep assertions independent of the compiler's choice of import paths.
  return raw.replace(/import\("[^"]+"\)/g, 'import("figbird")')
}
