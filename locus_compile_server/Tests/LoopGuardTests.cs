using System.Reflection;
using System.Runtime.Loader;
using Locus;
using Locus.CompileServer;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Locus.CompileServer.Tests;

public class LoopGuardTests
{
    private const string Host = UnitySnippetSource.HostTypeName;

    private static SyntaxTree Snippet(string body) =>
        CSharpSyntaxTree.ParseText(
            UnitySnippetSource.BuildAsyncSnippetSource(Host, "", body, expressionMode: false, useAsyncWrapper: false),
            path: UnitySnippetSource.SourcePath);

    private static int GuardCount(SyntaxTree tree) =>
        tree.GetRoot()
            .DescendantNodes()
            .OfType<MemberAccessExpressionSyntax>()
            .Count(access => access.Name.Identifier.ValueText == LocusSnippetLoopGuard.FieldName);

    [Fact]
    public void Every_loop_form_is_guarded_including_lambdas_and_local_functions()
    {
        const string body = """
            int n = 0;
            while (n < 3) n++;
            do { n--; } while (n > 0);
            for (int i = 0; i < 2; i++) { }
            foreach (var x in new[] { 1, 2 }) n += x;
            foreach (var (a, b) in new[] { (1, 2) }) n += a + b;
            System.Action spin = () => { while (n > 100) { } };
            int Local() { for (;;) { return n; } }
            print(Local());
            """;
        SyntaxTree guarded = LocusSnippetLoopGuard.Apply(Snippet(body), Host);

        Assert.Equal(7, GuardCount(guarded));
        var host = guarded.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>().Single();
        Assert.Single(host.Members.OfType<FieldDeclarationSyntax>(),
            field => field.Declaration.Variables.Any(v => v.Identifier.ValueText == LocusSnippetLoopGuard.FieldName));
        Assert.Contains("global::Locus.RuntimeSnippets.__LocusAsyncSnippetHost.__locusLoopCancel != 0", guarded.ToString());
        // Applying twice changes nothing.
        Assert.Same(guarded, LocusSnippetLoopGuard.Apply(guarded, Host));
    }

    [Fact]
    public void Snippets_without_loops_are_left_untouched()
    {
        SyntaxTree tree = Snippet("print(1 + 2);");
        Assert.Same(tree, LocusSnippetLoopGuard.Apply(tree, Host));
    }

    [Fact]
    public void Guards_never_move_user_code_to_another_line()
    {
        const string body = """
            int total = 0;
            for (int i = 0; i < 3; i++)
                total += i;
            while (total > 10)
            {
                total--;
            }
            var marker = total;
            """;
        SyntaxTree original = Snippet(body);
        SyntaxTree guarded = LocusSnippetLoopGuard.Apply(original, Host);

        int MarkerLine(SyntaxTree tree)
        {
            SyntaxToken token = tree.GetRoot()
                .DescendantTokens()
                .First(t => t.IsKind(SyntaxKind.IdentifierToken) && t.ValueText == "marker");
            return tree.GetMappedLineSpan(token.Span).StartLinePosition.Line;
        }

        Assert.Equal(original.GetText().Lines.Count, guarded.GetText().Lines.Count);
        // `#line 1` maps the snippet body: `var marker` is body line 8 (0-based 7).
        Assert.Equal(7, MarkerLine(original));
        Assert.Equal(MarkerLine(original), MarkerLine(guarded));
    }

    [Fact]
    public void A_spinning_loop_stops_when_the_field_is_set()
    {
        const string source = """
            namespace Locus.RuntimeSnippets
            {
                public static class __LocusAsyncSnippetHost
                {
                    public static long Spins;
                    public static void Run()
                    {
                        while (true) { Spins++; }
                    }
                }
            }
            """;
        SyntaxTree tree = LocusSnippetLoopGuard.Apply(CSharpSyntaxTree.ParseText(source), Host);
        string[] trusted = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator);
        CSharpCompilation compilation = CSharpCompilation.Create(
            "LoopGuardRuntimeTest",
            new[] { tree },
            trusted.Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release));
        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));

        var context = new AssemblyLoadContext("loop-guard-test", isCollectible: true);
        try
        {
            stream.Position = 0;
            Type host = context.LoadFromStream(stream).GetType("Locus.RuntimeSnippets." + Host, true)!;
            MethodInfo run = host.GetMethod("Run")!;
            FieldInfo cancel = host.GetField(LocusSnippetLoopGuard.FieldName, BindingFlags.Public | BindingFlags.Static)!;
            FieldInfo spins = host.GetField("Spins")!;

            Exception? thrown = null;
            var thread = new Thread(() =>
            {
                try { run.Invoke(null, null); }
                catch (TargetInvocationException ex) { thrown = ex.InnerException; }
            }) { IsBackground = true };
            thread.Start();
            SpinWait.SpinUntil(() => (long)spins.GetValue(null)! > 1000, TimeSpan.FromSeconds(5));

            cancel.SetValue(null, 1);
            Assert.True(thread.Join(TimeSpan.FromSeconds(5)), "the guarded loop did not stop");
            Assert.IsType<OperationCanceledException>(thrown);
        }
        finally
        {
            context.Unload();
        }
    }
}
