; Marketplace Intelligence — instalador Windows (Inno Setup 6)
;
; Empacota:
;   - serviço local (dist/local-agent/main.js + migrations)
;   - host de mensagens nativas (dist/native-host/native-host.js)
;   - node.exe embarcado (runtime, nenhuma instalação de Node exigida)
;   - extensão MV3 (dist/extension) para carregar no Chrome/Edge
;
; Depois de instalar, registra o host nativo no HKCU (Chrome e Edge) apontando
; para o manifesto que autoriza a origem da extensão.
;
; Compilar: ISCC.exe installer/marketplace-intelligence.iss /DAppVersion=3.19.0

#ifndef AppVersion
  #define AppVersion "3.19.0"
#endif
#ifndef ExtensionId
  ; ID de desenvolvimento: o instalador grava o ID informado no build.
  #define ExtensionId "iindgpgiecidhmfapdlfinpplndiiajf"
#endif
#ifndef SourceRoot
  #define SourceRoot ".."
#endif

#define AppName "Marketplace Intelligence"
#define AppPublisher "Marketplace Intelligence"
#define HostName "com.marketplaceintelligence.host"

[Setup]
AppId={{8E2B1D0C-5A4F-4E1B-9C3D-7A6F2B4C1E90}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\Marketplace Intelligence
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir={#SourceRoot}\installer\output
OutputBaseFilename=MarketplaceIntelligence-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\node.exe
LicenseFile={#SourceRoot}\installer\LICENSE.txt
SetupLogging=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
; Marcado por padrão: o usuário pediu atalho na Área de Trabalho.
Name: "desktopicon"; Description: "Criar atalho na Área de Trabalho"; GroupDescription: "Atalhos:"
Name: "autostart"; Description: "Iniciar o serviço local ao entrar no Windows"; GroupDescription: "Inicialização:"; Flags: unchecked

[Files]
; Runtime
Source: "{#SourceRoot}\tools\node.exe"; DestDir: "{app}"; Flags: ignoreversion
; Serviço local
Source: "{#SourceRoot}\dist\local-agent\main.js"; DestDir: "{app}\local-agent"; Flags: ignoreversion
Source: "{#SourceRoot}\dist\local-agent\package.json"; DestDir: "{app}\local-agent"; Flags: ignoreversion
Source: "{#SourceRoot}\dist\local-agent\openseo-mcp.mjs"; DestDir: "{app}\local-agent"; Flags: ignoreversion
Source: "{#SourceRoot}\dist\local-agent\third-party\open-seo\LICENSE"; DestDir: "{app}\local-agent\third-party\open-seo"; Flags: ignoreversion
Source: "{#SourceRoot}\dist\local-agent\migrations\*.sql"; DestDir: "{app}\local-agent\migrations"; Flags: ignoreversion
; Host nativo
Source: "{#SourceRoot}\dist\native-host\native-host.js"; DestDir: "{app}\native-host"; Flags: ignoreversion
Source: "{#SourceRoot}\dist\native-host\register.js"; DestDir: "{app}\native-host"; Flags: ignoreversion
Source: "{#SourceRoot}\dist\native-host\package.json"; DestDir: "{app}\native-host"; Flags: ignoreversion
; Extensão (para carregar no navegador)
Source: "{#SourceRoot}\dist\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
; Painel local (interface do serviço)
Source: "{#SourceRoot}\packages\local-agent\panel\src\*"; DestDir: "{app}\local-agent\panel\dist"; Flags: ignoreversion recursesubdirs
; Utilitários
Source: "{#SourceRoot}\installer\scripts\update-manager.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\installer\scripts\start-panel.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\installer\scripts\install-extension.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\installer\scripts\abrir-extensoes.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\installer\scripts\abrir-navegador.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\installer\scripts\unregister-host.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{localappdata}\MarketplaceIntelligence"; Permissions: users-full
Name: "{localappdata}\MarketplaceIntelligence\logs"; Permissions: users-full

[Registry]
; Início automático no logon do usuário atual (HKCU, não exige administrador).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "MarketplaceIntelligence"; ValueData: """{app}\start-panel.cmd"" --background"; Flags: uninsdeletevalue; Tasks: autostart
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "MarketplaceIntelligence"; Flags: deletevalue; Tasks: not autostart

[Icons]
Name: "{group}\{#AppName} — Painel local"; Filename: "{app}\start-panel.cmd"; IconFilename: "{app}\node.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\start-panel.cmd"; IconFilename: "{app}\node.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{group}\{#AppName} — Pré-Start e diagnóstico"; Filename: "{app}\start-panel.cmd"; Parameters: "--prestart"; IconFilename: "{app}\node.exe"; WorkingDir: "{app}"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"

[Run]
; Registra o host nativo no HKCU (não exige administrador).
; O ID vem da chave fixa no manifest da extensão: é sempre o mesmo, então o host
; pode ser registrado agora, antes de o usuário carregar a extensão no navegador.
Filename: "{app}\node.exe"; Parameters: """{app}\native-host\register.js"" --extension-id={#ExtensionId}"; Flags: runhidden waituntilterminated; StatusMsg: "Registrando o host nativo para Chrome e Edge..."
Filename: "{app}\start-panel.cmd"; Description: "Abrir o painel local agora (Pré-Start e diagnóstico)"; Flags: postinstall nowait skipifsilent
; Início automático com o Windows, sem janela: o serviço sobe em segundo plano e
; o atalho do Menu Iniciar só abre a tela no navegador.
Filename: "{app}\start-panel.cmd"; Parameters: "--background"; Flags: runhidden nowait; Tasks: autostart

[UninstallRun]
Filename: "{app}\node.exe"; Parameters: """{app}\native-host\register.js"" --unregister"; Flags: runhidden waituntilterminated

[Code]
{ Grava o ID da extensão usado no manifesto, para o registro apontar a origem certa. }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    SaveStringToFile(ExpandConstant('{localappdata}\MarketplaceIntelligence\extension-id.txt'),
      '{#ExtensionId}', False);
  end;
end;
