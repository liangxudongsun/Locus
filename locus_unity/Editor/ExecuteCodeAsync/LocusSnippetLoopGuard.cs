#nullable disable
// Shared source: compiled into the Unity plugin (in-Unity snippet compile
// path) and linked into the Locus compile server (LocusCompileServer.csproj),
// so both compile paths produce the same guarded snippets. Keep it valid for
// Unity's C# 9 compiler and Roslyn 3.8 (Locus.Roslyn.dll) as well as the
// compile server's current Roslyn.

using System.Linq;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Locus
{
    /// <summary>
    /// Makes loops in agent snippets cancellable. Each loop body inside the
    /// snippet host type starts with one read of a static volatile int field
    /// on that type; the executor sets the field when the execution is
    /// canceled, so a loop stuck on the Unity main thread leaves at its next
    /// iteration with <see cref="System.OperationCanceledException"/> instead
    /// of requiring an Editor restart.
    ///
    /// Cost: one volatile int load per iteration (within measurement noise
    /// under the optimizing JIT, about 0.2 ns under Unity's Debug code
    /// optimization). Snippets without loops are left unchanged. Inserted code
    /// never adds a line break, so <c>#line</c>-mapped diagnostics keep their
    /// line numbers. Recursion and <c>goto</c> loops are not guarded.
    /// </summary>
    public static class LocusSnippetLoopGuard
    {
        public const string FieldName = "__locusLoopCancel";

        public const string CanceledMessage =
            "Locus canceled this snippet; a loop stopped at its cancellation check.";

        /// <summary>
        /// Return <paramref name="tree"/> with every loop inside the class
        /// named <paramref name="hostTypeName"/> guarded and the guard field
        /// added to that class. Returns the input when there is nothing to do.
        /// </summary>
        public static SyntaxTree Apply(SyntaxTree tree, string hostTypeName)
        {
            if (tree == null || string.IsNullOrEmpty(hostTypeName))
                return tree;

            SyntaxNode root = tree.GetRoot();
            ClassDeclarationSyntax host = root
                .DescendantNodes()
                .OfType<ClassDeclarationSyntax>()
                .FirstOrDefault(declaration => declaration.Identifier.ValueText == hostTypeName);
            if (host == null || HasGuardField(host))
                return tree;

            string fieldAccess = "global::" + QualifiedName(host) + "." + FieldName;
            StatementSyntax guard = SyntaxFactory.ParseStatement(
                "if (" + fieldAccess + " != 0) throw new global::System.OperationCanceledException(\"" +
                CanceledMessage + "\");");

            var rewriter = new LoopRewriter(guard);
            var guardedHost = (ClassDeclarationSyntax)rewriter.Visit(host);
            if (rewriter.GuardedLoops == 0)
                return tree;

            MemberDeclarationSyntax field = SyntaxFactory.ParseMemberDeclaration(
                "public static volatile int " + FieldName + ";");
            guardedHost = guardedHost.AddMembers(field);
            return tree.WithRootAndOptions(root.ReplaceNode(host, guardedHost), tree.Options);
        }

        private static bool HasGuardField(ClassDeclarationSyntax host)
        {
            return host.Members
                .OfType<FieldDeclarationSyntax>()
                .Any(field => field.Declaration.Variables.Any(
                    variable => variable.Identifier.ValueText == FieldName));
        }

        private static string QualifiedName(ClassDeclarationSyntax host)
        {
            string name = host.Identifier.ValueText;
            foreach (SyntaxNode ancestor in host.Ancestors())
            {
                var type = ancestor as TypeDeclarationSyntax;
                if (type != null)
                {
                    name = type.Identifier.ValueText + "." + name;
                    continue;
                }

                var ns = ancestor as NamespaceDeclarationSyntax;
                if (ns != null)
                    name = ns.Name.ToString().Trim() + "." + name;
            }

            return name;
        }

        private sealed class LoopRewriter : CSharpSyntaxRewriter
        {
            private readonly StatementSyntax _guard;

            public int GuardedLoops;

            public LoopRewriter(StatementSyntax guard)
            {
                _guard = guard.WithoutTrivia();
            }

            public override SyntaxNode VisitWhileStatement(WhileStatementSyntax node)
            {
                var visited = (WhileStatementSyntax)base.VisitWhileStatement(node);
                return visited.WithStatement(Guard(visited.Statement));
            }

            public override SyntaxNode VisitDoStatement(DoStatementSyntax node)
            {
                var visited = (DoStatementSyntax)base.VisitDoStatement(node);
                return visited.WithStatement(Guard(visited.Statement));
            }

            public override SyntaxNode VisitForStatement(ForStatementSyntax node)
            {
                var visited = (ForStatementSyntax)base.VisitForStatement(node);
                return visited.WithStatement(Guard(visited.Statement));
            }

            public override SyntaxNode VisitForEachStatement(ForEachStatementSyntax node)
            {
                var visited = (ForEachStatementSyntax)base.VisitForEachStatement(node);
                return visited.WithStatement(Guard(visited.Statement));
            }

            public override SyntaxNode VisitForEachVariableStatement(ForEachVariableStatementSyntax node)
            {
                var visited = (ForEachVariableStatementSyntax)base.VisitForEachVariableStatement(node);
                return visited.WithStatement(Guard(visited.Statement));
            }

            /// <summary>
            /// Put the guard first in the body without adding line breaks: in
            /// a block it shares the line after <c>{</c>; a single statement is
            /// wrapped in a block that inherits the statement's own trivia.
            /// </summary>
            private StatementSyntax Guard(StatementSyntax body)
            {
                GuardedLoops++;
                var block = body as BlockSyntax;
                if (block != null)
                    return block.WithStatements(block.Statements.Insert(0, _guard));

                return SyntaxFactory.Block(_guard, body.WithoutTrivia())
                    .WithLeadingTrivia(body.GetLeadingTrivia())
                    .WithTrailingTrivia(body.GetTrailingTrivia());
            }
        }
    }
}
