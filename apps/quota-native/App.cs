using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

[assembly: AssemblyTitle("AI Quota Window")]
[assembly: AssemblyVersion("0.2.0.1")]
[assembly: AssemblyInformationalVersion("0.2.0-native.1")]
[assembly: AssemblyCopyright("Copyright (c) 2026 ZedekiahS")]

namespace AIQuota {
    internal sealed class App {
        Window window;
        Settings settings;
        BalanceReader reader;
        string settingsFile;
        Forms.NotifyIcon tray;
        DispatcherTimer polling, animation, hold;
        EventWaitHandle show;
        RegisteredWaitHandle showWait;
        bool expanded, dragging, quitting, selecting;
        double phase;
        NativePoint dragPointer;
        NativeRect dragWindow;
        Snapshot snapshot = new Snapshot();
        Quota selected;
        T Get<T>(string name) where T : class { return window.FindName(name) as T; }
        [STAThread] static int Main() {
            bool owner;
            using (var mutex = new Mutex(true, "Local\\AIQuotaNative", out owner)) {
                if (!owner) { try { using (var existing = EventWaitHandle.OpenExisting("Local\\AIQuotaNativeShow")) existing.Set(); } catch (WaitHandleCannotBeOpenedException) { } return 0; }
                try { new App().Run(); return 0; }
                catch (Exception e) { if (!(e is IOException || e is UnauthorizedAccessException || e is System.Security.SecurityException || e is XamlParseException || e is InvalidOperationException)) throw; MessageBox.Show("额度窗未能启动，请检查应用目录和可用空间。", "AI 额度窗"); return 1; }
            }
        }
        void Run() {
            var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ai-quota-window-native");
            settingsFile = Path.Combine(data, "settings.json"); settings = Settings.Load(settingsFile);
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Window.xaml")) window = (Window)XamlReader.Load(stream);
            window.Icon = System.Windows.Media.Imaging.BitmapFrame.Create(new Uri(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.ico")));
            reader = new BalanceReader(() => new QuotaRpc(QuotaRpc.FindCodex()), () => DateTimeOffset.UtcNow);
            window.Topmost = settings.Pinned;
            Get<CheckBox>("Pinned").IsChecked = settings.Pinned; Get<CheckBox>("Motion").IsChecked = settings.Motion;
            Get<TextBlock>("SaveStatus").Text = settings.Notice;
            Get<CheckBox>("Pinned").Click += delegate { settings.Pinned = Get<CheckBox>("Pinned").IsChecked == true; window.Topmost = settings.Pinned; Save(); };
            Get<CheckBox>("Motion").Click += delegate { settings.Motion = Get<CheckBox>("Motion").IsChecked == true; UpdateAnimation(); Save(); };
            Get<Button>("Smaller").Click += delegate { Resize(-.1); }; Get<Button>("Larger").Click += delegate { Resize(.1); };
            Get<Button>("Collapse").Click += delegate { Expand(false); };
            Get<Button>("Hide").Click += delegate { window.Hide(); UpdateAnimation(); };
            Get<Button>("Refresh").Click += async delegate { await Refresh(); };
            Get<ComboBox>("Windows").SelectionChanged += delegate { if (selecting) return; var item = Get<ComboBox>("Windows").SelectedItem as ComboBoxItem; if (item != null) { settings.QuotaKey = (string)item.Tag; Save(); Paint(); } };
            var orb = Get<Grid>("Orb");
            hold = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            hold.Tick += delegate { hold.Stop(); if (Mouse.LeftButton == MouseButtonState.Pressed) { dragging = true; MoveWithPointer(); } };
            orb.MouseLeftButtonDown += delegate {
                dragging = false; GetCursorPos(out dragPointer);
                GetWindowRect(new System.Windows.Interop.WindowInteropHelper(window).Handle, out dragWindow);
                orb.CaptureMouse(); hold.Start(); orb.Focus();
            };
            orb.MouseMove += delegate { if (dragging && Mouse.LeftButton == MouseButtonState.Pressed) MoveWithPointer(); };
            orb.MouseLeftButtonUp += delegate {
                hold.Stop(); bool moved = dragging; dragging = false; orb.ReleaseMouseCapture();
                if (moved) { Clamp(); Save(); } else Expand(!expanded);
            };
            orb.LostMouseCapture += delegate { hold.Stop(); if (dragging) { dragging = false; Clamp(); Save(); } };
            orb.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Enter || e.Key == Key.Space) { Expand(!expanded); e.Handled = true; } };
            window.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape) Expand(false); };
            window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) { if (!quitting) { e.Cancel = true; window.Hide(); UpdateAnimation(); } };
            tray = new Forms.NotifyIcon { Icon = new System.Drawing.Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.ico")), Text = "AI 额度窗", Visible = true, ContextMenuStrip = new Forms.ContextMenuStrip() };
            tray.ContextMenuStrip.Items.Add("显示额度窗", null, delegate { Show(); });
            tray.ContextMenuStrip.Items.Add("退出额度窗", null, delegate { Quit(); });
            tray.DoubleClick += delegate { Show(); };
            show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AIQuotaNativeShow");
            showWait = ThreadPool.RegisterWaitForSingleObject(show, delegate { window.Dispatcher.BeginInvoke(new Action(Show)); }, null, Timeout.Infinite, false);
            polling = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
            polling.Tick += async delegate { if (quitting) return; if (window.IsVisible) Paint(); if (DateTimeOffset.UtcNow >= reader.NextAllowed) await Refresh(); };
            animation = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
            animation.Tick += delegate { phase = (phase + .75) % 120; Water(); };
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged += DisplaysChanged;
            Microsoft.Win32.SystemEvents.PowerModeChanged += PowerChanged;
            application.SessionEnding += delegate { Quit(); };
            window.Loaded += async delegate { Clamp(); Save(); polling.Start(); UpdateAnimation(); await Refresh(); };
            Resize(0);
            window.Left = double.IsNaN(settings.Left) ? SystemParameters.WorkArea.Right - window.Width - 40 : settings.Left;
            window.Top = double.IsNaN(settings.Top) ? SystemParameters.WorkArea.Top + 80 : settings.Top;
            application.Run(window);
        }
        void Show() { if (quitting) return; window.Show(); Clamp(); window.Activate(); UpdateAnimation(); Paint(); }
        // Pointer and HWND bounds both use physical pixels; never mix WPF DIPs with cursor pixels.
        void MoveWithPointer() {
            NativePoint current; if (!GetCursorPos(out current)) return;
            SetWindowPos(new System.Windows.Interop.WindowInteropHelper(window).Handle, IntPtr.Zero,
                dragWindow.Left + current.X - dragPointer.X, dragWindow.Top + current.Y - dragPointer.Y, 0, 0, 0x0015);
        }
        [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct NativeRect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] static extern bool GetCursorPos(out NativePoint point);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        void DisplaysChanged(object sender, EventArgs e) { window.Dispatcher.BeginInvoke(new Action(() => { Clamp(); Save(); })); }
        void PowerChanged(object sender, Microsoft.Win32.PowerModeChangedEventArgs e) { if (e.Mode == Microsoft.Win32.PowerModes.Resume) window.Dispatcher.BeginInvoke(new Action(async () => { Paint(); await Refresh(); })); }
        async Task Refresh() {
            if (quitting) return;
            Get<Button>("Refresh").IsEnabled = false;
            try { snapshot = await reader.Refresh(); if (!quitting) { Populate(); Paint(); } }
            finally { if (!quitting) Get<Button>("Refresh").IsEnabled = DateTimeOffset.UtcNow >= reader.NextAllowed; }
        }
        void Populate() {
            selecting = true;
            var combo = Get<ComboBox>("Windows"); combo.Items.Clear();
            if (string.IsNullOrEmpty(settings.QuotaKey) && snapshot.Quotas.Count > 0) settings.QuotaKey = snapshot.Quotas[0].Key;
            foreach (var q in snapshot.Quotas) {
                var item = new ComboBoxItem { Content = q.Label + (snapshot.Quotas.Select(x => x.Pool).Distinct().Count() > 1 ? " · " + q.Pool : ""), Tag = q.Key };
                combo.Items.Add(item); if (q.Key == settings.QuotaKey) combo.SelectedItem = item;
            }
            if (combo.SelectedItem == null) { var unavailable = new ComboBoxItem { Content = "关注的额度暂不可用", Tag = settings.QuotaKey }; combo.Items.Add(unavailable); combo.SelectedItem = unavailable; }
            selecting = false;
        }
        void Paint() {
            var now = DateTimeOffset.UtcNow; selected = snapshot.Quotas.Find(q => q.Key == settings.QuotaKey);
            bool fresh = selected != null && selected.Fresh(snapshot.Observed, now);
            string percent = fresh && selected.Remaining.HasValue ? selected.Remaining.Value.ToString("0") + "%" : "?";
            Get<TextBlock>("Percent").Text = percent;
            Get<TextBlock>("OrbLabel").Text = selected == null ? "剩余额度" : selected.Label;
            Get<TextBlock>("Account").Text = snapshot.Account;
            Get<TextBlock>("Reset").Text = selected != null && selected.Reset.HasValue ? "重置于 " + selected.Reset.Value.LocalDateTime.ToString("M月d日 HH:mm") : "重置时间未知";
            Get<TextBlock>("Status").Text = snapshot.Error != "" ? snapshot.Error : selected == null ? "额度暂不可用，请确认 Codex 已登录。" : !fresh ? "额度已过期，等待更新。" : !selected.Remaining.HasValue ? "该窗口未提供余额。" : "刚刚更新 · 剩余 " + percent;
            if (fresh && selected.Remaining.HasValue && now - snapshot.Observed >= TimeSpan.FromMinutes(1)) Get<TextBlock>("Status").Text = "更新于 " + snapshot.Observed.LocalDateTime.ToString("HH:mm") + " · 剩余 " + percent;
            Get<Button>("Refresh").IsEnabled = now >= reader.NextAllowed;
            Get<Grid>("Orb").ToolTip = (selected == null ? "额度未知" : selected.Label + " · " + percent) + "\n点击查看 · 长按拖动";
            Water();
        }
        void Water() {
            var valid = selected != null && selected.Remaining.HasValue && selected.Fresh(snapshot.Observed, DateTimeOffset.UtcNow);
            double amount = valid ? selected.Remaining.Value : 0;
            Get<Canvas>("Water").Visibility = amount > 0 ? Visibility.Visible : Visibility.Hidden;
            // Adapted two-layer periodic wave motion from codex-quota-orb; 120 is its path period.
            double waterline = amount >= 100 ? -24 : 100 - amount - 10;
            Canvas.SetTop(Get<System.Windows.Shapes.Path>("FrontWave"), waterline);
            Canvas.SetTop(Get<System.Windows.Shapes.Path>("BackWave"), waterline - 2);
            Canvas.SetLeft(Get<System.Windows.Shapes.Path>("FrontWave"), -phase);
            Canvas.SetLeft(Get<System.Windows.Shapes.Path>("BackWave"), -120 + phase * .62);
        }
        void UpdateAnimation() { if (animation == null) return; if (window.IsVisible && settings.Motion && SystemParameters.ClientAreaAnimation) animation.Start(); else animation.Stop(); }
        void Resize(double by) {
            settings.Scale = Math.Round(Math.Max(.7, Math.Min(1.5, settings.Scale + by)), 1);
            Get<Viewbox>("OrbBox").Width = Get<Viewbox>("OrbBox").Height = 112 * settings.Scale;
            Get<TextBlock>("SizeLabel").Text = (settings.Scale * 100).ToString("0") + "%";
            Get<Button>("Smaller").IsEnabled = settings.Scale > .7; Get<Button>("Larger").IsEnabled = settings.Scale < 1.5;
            window.Width = expanded ? 296 : 112 * settings.Scale;
            window.SizeToContent = expanded ? SizeToContent.Height : SizeToContent.Manual;
            if (!expanded) window.Height = 112 * settings.Scale;
            if (window.IsLoaded) { Clamp(); Save(); }
        }
        void Expand(bool value) { expanded = value; Get<Border>("Details").Visibility = value ? Visibility.Visible : Visibility.Collapsed; Resize(0); window.UpdateLayout(); Clamp(); if (value) Get<ComboBox>("Windows").Focus(); }
        void Clamp() {
            if (!window.IsLoaded) return;
            var hwnd = new System.Windows.Interop.WindowInteropHelper(window).Handle;
            var screen = Forms.Screen.FromHandle(hwnd).WorkingArea;
            var source = PresentationSource.FromVisual(window);
            var transform = source.CompositionTarget.TransformFromDevice;
            var top = transform.Transform(new Point(screen.Left, screen.Top)); var bottom = transform.Transform(new Point(screen.Right, screen.Bottom));
            window.Left = Math.Max(top.X, Math.Min(window.Left, bottom.X - window.ActualWidth));
            window.Top = Math.Max(top.Y, Math.Min(window.Top, bottom.Y - window.ActualHeight));
        }
        void Save() {
            settings.Left = window.Left; settings.Top = window.Top;
            try { settings.Save(settingsFile); Get<TextBlock>("SaveStatus").Text = settings.Notice; }
            catch (IOException) { Get<TextBlock>("SaveStatus").Text = "设置未保存，请检查磁盘空间。"; }
            catch (UnauthorizedAccessException) { Get<TextBlock>("SaveStatus").Text = "设置未保存，请检查目录权限。"; }
        }
        void Quit() {
            if (quitting) return; quitting = true;
            hold.Stop(); polling.Stop(); animation.Stop(); Save(); reader.Dispose();
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= DisplaysChanged;
            Microsoft.Win32.SystemEvents.PowerModeChanged -= PowerChanged;
            showWait.Unregister(null); show.Dispose(); tray.Visible = false; tray.Icon.Dispose(); tray.Dispose();
            window.Close(); Application.Current.Shutdown();
        }
    }
}
