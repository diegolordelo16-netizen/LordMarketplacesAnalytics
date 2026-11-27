using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class StartPanel
{
    private const string Product = "Marketplace Intelligence";

    [STAThread]
    private static int Main(string[] args)
    {
        bool background = args.Length == 1 && args[0] == "--background";
        string mode = args.Length == 1 ? args[0] : "";
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        string log = String.IsNullOrWhiteSpace(local) ? null :
            Path.Combine(local, "MarketplaceIntelligence", "logs", "launcher.log");
        string url;
        try
        {
            if (args.Length > 1 || (mode != "" && mode != "--prestart" && mode != "--background"))
                throw new InvalidOperationException("Modo de inicialização inválido.");
            using (var mutex = new Mutex(false, @"Local\MarketplaceIntelligenceLauncher"))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(125000); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new TimeoutException("Outra inicialização do serviço local ainda está em andamento.");
                try { url = StartService(AppDomain.CurrentDomain.BaseDirectory, mode); }
                finally { mutex.ReleaseMutex(); }
            }
            if (background) return 0;
            var localUrl = Regex.Match(url, @"\Ahttp://127\.0\.0\.1:([0-9]{1,5})(/|/prestart)\z");
            int port;
            if (!localUrl.Success || !Int32.TryParse(localUrl.Groups[1].Value, out port) ||
                port < 1 || port > 65535 || localUrl.Groups[2].Value != (mode == "--prestart" ? "/prestart" : "/"))
                throw new InvalidOperationException("O serviço não retornou uma URL local válida.");
        }
        catch (Exception error)
        {
            WriteLog(log, "Falha ao iniciar: " + error.Message);
            if (!background)
            {
                MessageBox.Show("Não foi possível iniciar o serviço local." +
                    (log == null ? "" : "\n\nConsulte o diagnóstico em:\n" + log),
                    Product, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return 1;
        }

        if (OpenBrowser(url, local, log))
        {
            WriteLog(log, "Navegador aberto: " + url);
            return 0;
        }

        MessageBox.Show("O serviço está pronto. Abra o endereço abaixo no seu navegador:\n\n" + url,
            Product, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 1;
    }

    private static string StartService(string root, string mode)
    {
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(root, "node.exe"),
            Arguments = "\"" + Path.Combine(root, "start-panel.mjs") + "\" " + mode,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using (var process = Process.Start(start))
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(120000))
            {
                try { process.Kill(); }
                catch (InvalidOperationException) { }
                throw new TimeoutException("O serviço local excedeu o tempo limite de inicialização.");
            }
            if (!Task.WaitAll(new Task[] { output, errors }, 5000))
                throw new TimeoutException("Não foi possível ler a resposta do serviço local.");
            if (process.ExitCode != 0)
            {
                var message = errors.Result.Trim();
                throw new InvalidOperationException(message.Length == 0
                    ? "O serviço local encerrou com código " + process.ExitCode + "."
                    : message);
            }
            return output.Result.Trim();
        }
    }

    private static bool OpenBrowser(string url, string local, string log)
    {
        if (TryOpen(new ProcessStartInfo { FileName = url, UseShellExecute = true }, log))
            return true;

        string[] paths = {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            local
        };
        foreach (string root in paths)
        {
            if (String.IsNullOrWhiteSpace(root)) continue;
            foreach (string relativePath in new[] { @"Microsoft\Edge\Application\msedge.exe", @"Google\Chrome\Application\chrome.exe" })
            {
                var path = Path.Combine(root, relativePath);
                if (File.Exists(path) && TryOpen(new ProcessStartInfo
                    { FileName = path, Arguments = url, UseShellExecute = true }, log))
                    return true;
            }
        }
        return false;
    }

    private static bool TryOpen(ProcessStartInfo start, string log)
    {
        try
        {
            using (Process.Start(start)) { }
            return true;
        }
        catch (Exception error)
        {
            WriteLog(log, "Falha ao abrir o navegador: " + error.Message);
            return false;
        }
    }

    private static void WriteLog(string path, string message)
    {
        if (path == null) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.AppendAllText(path, DateTimeOffset.Now.ToString("O") + " " + message + Environment.NewLine);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
