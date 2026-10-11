' Lanza run-monitor.cmd sin ventana (evita el parpadeo de la consola cada 10 min).
' Acción de la tarea programada: wscript.exe "<carpeta>\run-monitor-hidden.vbs"
' La carpeta se deduce de la ubicación de este archivo, así que no hay rutas fijas.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & dir & "\run-monitor.cmd""", 0, False
