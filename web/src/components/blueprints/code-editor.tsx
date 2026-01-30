"use client";

import { useCallback } from "react";
import dynamic from "next/dynamic";
import { Plus, Trash2, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { CodeSnippet } from "@/types/blueprint";

// Dynamically import Monaco to avoid SSR issues
const Editor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="h-[300px] rounded-md border bg-muted/30">
      <Skeleton className="h-full w-full" />
    </div>
  ),
});

interface CodeEditorProps {
  snippets: CodeSnippet[];
  onChange: (snippets: CodeSnippet[]) => void;
}

// Language configurations for Monaco
const languages = [
  { value: "python", label: "Python", monacoId: "python" },
  { value: "javascript", label: "JavaScript", monacoId: "javascript" },
  { value: "typescript", label: "TypeScript", monacoId: "typescript" },
  { value: "bash", label: "Bash", monacoId: "shell" },
  { value: "shell", label: "Shell", monacoId: "shell" },
  { value: "json", label: "JSON", monacoId: "json" },
  { value: "yaml", label: "YAML", monacoId: "yaml" },
  { value: "sql", label: "SQL", monacoId: "sql" },
  { value: "go", label: "Go", monacoId: "go" },
  { value: "rust", label: "Rust", monacoId: "rust" },
  { value: "java", label: "Java", monacoId: "java" },
  { value: "csharp", label: "C#", monacoId: "csharp" },
  { value: "php", label: "PHP", monacoId: "php" },
  { value: "ruby", label: "Ruby", monacoId: "ruby" },
  { value: "swift", label: "Swift", monacoId: "swift" },
  { value: "kotlin", label: "Kotlin", monacoId: "kotlin" },
  { value: "dockerfile", label: "Dockerfile", monacoId: "dockerfile" },
  { value: "markdown", label: "Markdown", monacoId: "markdown" },
  { value: "html", label: "HTML", monacoId: "html" },
  { value: "css", label: "CSS", monacoId: "css" },
  { value: "other", label: "Other", monacoId: "plaintext" },
];

function getMonacoLanguage(language: string): string {
  const lang = languages.find((l) => l.value === language);
  return lang?.monacoId || "plaintext";
}

function createEmptySnippet(): CodeSnippet {
  return {
    language: "python",
    code: "",
    description: null,
    dependencies: [],
    inputs: [],
    outputs: [],
  };
}

export function CodeEditor({ snippets, onChange }: CodeEditorProps) {
  const addSnippet = useCallback(() => {
    onChange([...snippets, createEmptySnippet()]);
  }, [snippets, onChange]);

  const removeSnippet = useCallback(
    (index: number) => {
      onChange(snippets.filter((_, i) => i !== index));
    },
    [snippets, onChange]
  );

  const updateSnippet = useCallback(
    (index: number, field: keyof CodeSnippet, value: unknown) => {
      const newSnippets = [...snippets];
      newSnippets[index] = { ...newSnippets[index], [field]: value };
      onChange(newSnippets);
    },
    [snippets, onChange]
  );

  const parseList = (value: string): string[] => {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  return (
    <div className="space-y-4">
      {snippets.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-muted p-3 mb-4">
              <Code2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
              No code snippets yet. Add code examples to help agents implement
              this blueprint with working implementations.
            </p>
            <Button variant="outline" size="sm" onClick={addSnippet}>
              <Plus className="mr-2 h-4 w-4" />
              Add Code Snippet
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {snippets.map((snippet, index) => (
            <Card key={index} className="overflow-hidden">
              <CardContent className="p-0">
                {/* Header with language selector and controls */}
                <div className="flex items-center justify-between gap-4 p-4 border-b bg-muted/30">
                  <div className="flex items-center gap-4 flex-1">
                    <div className="w-40">
                      <Select
                        value={snippet.language}
                        onValueChange={(v) => updateSnippet(index, "language", v)}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {languages.map((lang) => (
                            <SelectItem key={lang.value} value={lang.value}>
                              {lang.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      value={snippet.description || ""}
                      onChange={(e) =>
                        updateSnippet(index, "description", e.target.value || null)
                      }
                      placeholder="Description (optional)"
                      className="h-8 flex-1 max-w-md"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeSnippet(index)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {/* Monaco Editor */}
                <div className="border-b">
                  <Editor
                    height="300px"
                    language={getMonacoLanguage(snippet.language)}
                    value={snippet.code}
                    onChange={(value) => updateSnippet(index, "code", value || "")}
                    theme="vs-dark"
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
                      fontLigatures: true,
                      lineNumbers: "on",
                      renderLineHighlight: "line",
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                      insertSpaces: true,
                      wordWrap: "on",
                      padding: { top: 12, bottom: 12 },
                      scrollbar: {
                        vertical: "auto",
                        horizontal: "auto",
                        verticalScrollbarSize: 8,
                        horizontalScrollbarSize: 8,
                      },
                      overviewRulerLanes: 0,
                      hideCursorInOverviewRuler: true,
                      overviewRulerBorder: false,
                      guides: {
                        indentation: true,
                        bracketPairs: true,
                      },
                      bracketPairColorization: {
                        enabled: true,
                      },
                      suggest: {
                        showKeywords: true,
                        showSnippets: true,
                      },
                    }}
                  />
                </div>

                {/* Metadata fields */}
                <div className="grid gap-4 p-4 md:grid-cols-3 bg-muted/20">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Dependencies
                    </Label>
                    <Input
                      value={snippet.dependencies.join(", ")}
                      onChange={(e) =>
                        updateSnippet(index, "dependencies", parseList(e.target.value))
                      }
                      placeholder="e.g., requests, pandas"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Inputs
                    </Label>
                    <Input
                      value={snippet.inputs.join(", ")}
                      onChange={(e) =>
                        updateSnippet(index, "inputs", parseList(e.target.value))
                      }
                      placeholder="e.g., api_url, token"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Outputs
                    </Label>
                    <Input
                      value={snippet.outputs.join(", ")}
                      onChange={(e) =>
                        updateSnippet(index, "outputs", parseList(e.target.value))
                      }
                      placeholder="e.g., result, status"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          <Button variant="outline" onClick={addSnippet} className="w-full">
            <Plus className="mr-2 h-4 w-4" />
            Add Code Snippet
          </Button>
        </>
      )}
    </div>
  );
}
