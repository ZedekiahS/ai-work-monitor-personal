using System;
using System.IO;

namespace AIQuota {
    internal sealed class Settings {
        public bool Pinned = true, Motion = true;
        public double Scale = 1, Left = double.NaN, Top = double.NaN;
        public string QuotaKey = "";
        public string Notice = "";
        public static Settings Load(string file) {
            if (!File.Exists(file)) return new Settings();
            try {
                if (new FileInfo(file).Length > 16384) throw new ArgumentException("settings-too-large");
                var obj = Json.Object(Json.Serializer().DeserializeObject(File.ReadAllText(file)));
                if (obj == null) throw new ArgumentException("settings-object-required");
                var value = new Settings();
                if (Json.Get(obj, "pinned") is bool) value.Pinned = (bool)obj["pinned"];
                if (Json.Get(obj, "motion") is bool) value.Motion = (bool)obj["motion"];
                double? size = Json.Number(Json.Get(obj, "scale"));
                if (size.HasValue) value.Scale = Math.Max(.7, Math.Min(1.5, size.Value));
                value.Left = Json.Number(Json.Get(obj, "left")) ?? double.NaN;
                value.Top = Json.Number(Json.Get(obj, "top")) ?? double.NaN;
                value.QuotaKey = Json.Get(obj, "quotaKey") as string ?? "";
                if (value.QuotaKey.Length > 512) value.QuotaKey = "";
                return value;
            } catch (ArgumentException) {
                File.Copy(file, file + ".damaged-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff"), false);
                return new Settings { Notice = "小窗设置已恢复默认，原文件已保留。" };
            }
        }
        public void Save(string file) {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            string temporary = file + ".tmp";
            File.WriteAllText(temporary, Json.Serializer().Serialize(new { pinned = Pinned, motion = Motion, scale = Scale, left = double.IsNaN(Left) ? (double?)null : Left, top = double.IsNaN(Top) ? (double?)null : Top, quotaKey = QuotaKey }));
            if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
        }
    }
}
