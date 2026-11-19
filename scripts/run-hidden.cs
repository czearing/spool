using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

internal static class HiddenRunner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value)
    {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            text.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            text.Append(character);
            slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 3) return 2;
        IntPtr job = IntPtr.Zero;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            var limits = new ExtendedLimit { Basic = new BasicLimit { Flags = 0x2000 } };
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            Directory.CreateDirectory(Path.GetDirectoryName(args[0]));
            if (File.Exists(args[0]) && new FileInfo(args[0]).Length > 10 * 1024 * 1024)
            {
                if (File.Exists(args[0] + ".1")) File.Delete(args[0] + ".1");
                File.Move(args[0], args[0] + ".1");
            }
            using (var log = TextWriter.Synchronized(new StreamWriter(args[0], true) { AutoFlush = true }))
            using (var process = new Process())
            {
                process.StartInfo = new ProcessStartInfo(args[2], string.Join(" ", args.Skip(3).Select(Quote))) {
                    WorkingDirectory = args[1], UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                process.OutputDataReceived += (sender, data) => { if (data.Data != null) log.WriteLine(data.Data); };
                process.ErrorDataReceived += (sender, data) => { if (data.Data != null) log.WriteLine(data.Data); };
                log.WriteLine("{0:o} Starting {1}", DateTime.UtcNow, args[2]);
                process.Start();
                if (!AssignProcessToJobObject(job, process.Handle))
                {
                    int error = Marshal.GetLastWin32Error();
                    process.Kill();
                    throw new System.ComponentModel.Win32Exception(error, "Cannot supervise child process lifetime");
                }
                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                log.WriteLine("{0:o} Exited {1}", DateTime.UtcNow, process.ExitCode);
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            File.AppendAllText(args[0], DateTime.UtcNow.ToString("o") + " Startup failed: " + error + Environment.NewLine);
            return 1;
        }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
