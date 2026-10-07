using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

// An isolated input target. It contains no automation or Computer Use helper protocol.
// Compile into scratch and control only its returned window through the official sky API.
class ComputerUseFixture : Form
{
    readonly TextBox input = new TextBox();
    readonly Label status = new Label();
    readonly string receipt;
    int clicks;

    ComputerUseFixture(string output)
    {
        receipt = Path.GetFullPath(output);
        Text = "Codex Computer Use Fixture 01a1119c";
        ClientSize = new Size(620, 210);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(new Label { Text = "Type the fixture text, then record it.", Location = new Point(24, 20), Size = new Size(560, 25) });
        input.AccessibleName = "Fixture input";
        input.Location = new Point(24, 55);
        input.Size = new Size(570, 30);
        Controls.Add(input);
        var button = new Button { Text = "Record fixture input", Location = new Point(24, 100), Size = new Size(210, 35) };
        button.Click += delegate { clicks++; WriteReceipt(); status.Text = "Recorded: " + input.Text; };
        Controls.Add(button);
        status.Location = new Point(24, 155);
        status.Size = new Size(570, 30);
        status.Text = "Waiting for fixture input";
        Controls.Add(status);
        Shown += delegate { WriteReceipt(); };
        FormClosed += delegate { WriteReceipt(); };
        var timer = new Timer { Interval = 600000 };
        timer.Tick += delegate { timer.Stop(); Close(); };
        timer.Start();
    }

    void WriteReceipt()
    {
        File.WriteAllText(receipt,
            "pid=" + Process.GetCurrentProcess().Id + "\n" +
            "clicks=" + clicks + "\n" +
            "text=" + input.Text.Replace("\r", "\\r").Replace("\n", "\\n") + "\n",
            new UTF8Encoding(false));
    }

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length > 1) throw new ArgumentException("Pass at most one fixture receipt path");
        var receipt = args.Length == 1 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "input-receipt.txt");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ComputerUseFixture(receipt));
    }
}
