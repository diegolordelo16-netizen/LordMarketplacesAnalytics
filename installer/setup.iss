; ─────────────────────────────────────────────────────────────────────────────
; Instalador do Lord Marketplaces Analytics (Inno Setup 6).
;
; O que ele resolve, e por que existe:
;  - o usuário não instala Node, Python, Git nem npm: o runtime vai embutido;
;  - o ID da extensão depende do caminho onde ela fica, então o instalador
;    calcula esse ID depois de instalar e grava em extension.json — o serviço
;    local passa a aceitar exatamente aquela origem, sem copiar ID à mão;
;  - cria atalho no menu Iniciar e (opcional) inicia com o Windows.
;
; Gerado por scripts/package-windows.mjs — as macros abaixo vêm do -D.
; ─────────────────────────────────────────────────────────────────────────────

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\release\LordMarketplacesAnalytics"
#endif
#ifndef OutputDir
  #define OutputDir "..\release"
#endif
#ifndef ExtensionId
  #define ExtensionId ""
#endif

[Setup]
AppId={{8F3C2A14-7B5D-4C9E-9A21-5D6E7F8A9B10}
AppName=Lord Marketplaces Analytics
AppVersion={#AppVersion}
AppVerName=Lord Marketplaces Analytics {#AppVersion}
AppPublisher=Lord
DefaultDirName={localappdata}\LordMarketplacesAnalytics
DefaultGroupName=Lord Marketplaces Analytics
DisableProgramGroupPage=yes
; Instalação por usuário: sem UAC, sem admin, sem escrever em Program Files.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutputDir}
OutputBaseFilename=Setup-LordMarketplacesAnalytics-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Lord Marketplaces Analytics
LicenseFile=LICENCA.txt
InfoBeforeFile=AVISO-DE-DADOS.txt
SetupLogging=yes
; Não apaga o banco na desinstalação: o dado é do usuário.
UsePreviousAppDir=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; GroupDescription: "Atalhos:"; Flags: unchecked
Name: "startup"; Description: "Iniciar o serviço junto com o Windows"; GroupDescription: "Inicialização:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Lord Marketplaces Analytics (servico + painel)"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Comment: "Sobe o servico local e abre o painel no navegador"
Name: "{group}\Painel do serviço local"; Filename: "http://127.0.0.1:47822/"
Name: "{group}\Instalar extensão no navegador"; Filename: "{app}\tools\instalar-extensao.cmd"
Name: "{group}\Pasta de dados"; Filename: "{localappdata}\LordMarketplacesAnalytics"
Name: "{group}\Desinstalar"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Lord Marketplaces Analytics"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Tasks: desktopicon; Comment: "Sobe o servico local e abre o painel no navegador"
Name: "{userstartup}\Lord Marketplaces Analytics"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"; Tasks: startup

[Run]
; Depois de instalar: sobe o serviço e abre a página de status, onde ficam o
; botão do painel, o token de pareamento e o caminho da extensão.
; O navegador só carrega uma extensão de pasta com o Modo do desenvolvedor
; ligado — isso o Windows não deixa um instalador fazer sozinho.
Filename: "{app}\start.cmd"; Description: "Iniciar o serviço local e abrir o painel"; Flags: postinstall nowait skipifsilent shellexec
Filename: "http://127.0.0.1:47822/"; Description: "Abrir o painel do serviço local"; Flags: postinstall shellexec nowait skipifsilent unchecked
Filename: "{app}\tools\instalar-extensao.cmd"; Description: "Abrir a tela de extensões do navegador"; Flags: postinstall nowait skipifsilent shellexec unchecked

[UninstallRun]
; Encerra o serviço se estiver rodando (só o nosso node.exe).
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM node.exe /FI ""WINDOWTITLE eq Lord Marketplaces Analytics*"""; Flags: runhidden skipifdoesntexist

[UninstallDelete]
; runtime.json e pairing.json são estado, não dado de negócio: podem sair.
Type: files; Name: "{localappdata}\LordMarketplacesAnalytics\runtime.json"
Type: files; Name: "{localappdata}\LordMarketplacesAnalytics\pairing.json"

[Code]
const
  TOOLS_SUB = '\tools\instalar-extensao.cmd';

{ O ID da extensão do Chrome vem do caminho onde ela foi instalada.
  Algoritmo do Chromium: sha256 do caminho (minúsculas, barras invertidas),
  primeiros 16 bytes em hex, com 0-9 remapeado para a-j. }
function NormalizeExtensionPath(const Dir: String): String;
var
  S: String;
  I: Integer;
begin
  S := Lowercase(Dir);
  Result := '';
  for I := 1 to Length(S) do
  begin
    if S[I] = '/' then
      Result := Result + #92
    else
      Result := Result + S[I];
  end;
  { Sem barra invertida no fim: o Chromium normaliza assim. }
  while (Length(Result) > 0) and (Result[Length(Result)] = #92) do
    Delete(Result, Length(Result), 1);
end;

function ExtensionIdForPath(const Dir: String): String;
var
  Digest: String;
  I: Integer;
  C: Char;
begin
  Digest := GetSHA256OfString(NormalizeExtensionPath(Dir));
  Digest := Copy(Digest, 1, 32);
  Result := '';
  for I := 1 to Length(Digest) do
  begin
    C := Digest[I];
    if (C >= '0') and (C <= '9') then
      Result := Result + Chr(Ord('a') + (Ord(C) - Ord('0')))
    else
      Result := Result + C;
  end;
end;

procedure WriteExtensionConfig(const ExtDir: String);
var
  ConfigDir: String;
  Id: String;
  Json: String;
begin
  ConfigDir := ExpandConstant('{localappdata}\LordMarketplacesAnalytics');
  ForceDirectories(ConfigDir);
  Id := ExtensionIdForPath(ExtDir);
  Json := '{"origin": "chrome-extension://' + Id + '", "installedAt": "' +
          GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + '"}' + #13#10;
  SaveStringToFile(ConfigDir + '\extension.json', Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExtDir: String;
  Script: TStringList;
begin
  if CurStep = ssPostInstall then
  begin
    ExtDir := ExpandConstant('{app}\extension');
    if DirExists(ExtDir) then
    begin
      WriteExtensionConfig(ExtDir);

      { O script de instalação aponta para a pasta real, não para um caminho
        relativo: quem clica precisa acertar a pasta na primeira tentativa. }
      Script := TStringList.Create;
      try
        Script.Add('@echo off');
        Script.Add('title Lord Marketplaces Analytics - instalar extensao');
        Script.Add('echo.');
        Script.Add('echo  Instalar a extensao no navegador');
        Script.Add('echo.');
        Script.Add('echo  1. Ative o "Modo do desenvolvedor" (canto superior direito).');
        Script.Add('echo  2. Clique em "Carregar sem compactacao".');
        Script.Add('echo  3. Escolha esta pasta:');
        Script.Add('echo.');
        Script.Add('echo      ' + ExtDir);
        Script.Add('echo.');
        Script.Add('echo  O ID ja esta registrado no servico local: nao copie nada.');
        Script.Add('echo.');
        Script.Add('pause');
        Script.Add('start "" chrome "chrome://extensions/"');
        Script.SaveToFile(ExpandConstant('{app}') + TOOLS_SUB);
      finally
        Script.Free;
      end;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    { O banco NÃO é apagado: o dado é do usuário. Só avisamos onde ficou. }
    if FileExists(ExpandConstant('{localappdata}\LordMarketplacesAnalytics\data.db')) then
      MsgBox('Seus dados foram preservados em:' + #13#10 +
             ExpandConstant('{localappdata}\LordMarketplacesAnalytics\data.db') + #13#10#13#10 +
             'Apague esse arquivo manualmente se quiser remover o histórico.',
             mbInformation, MB_OK);
  end;
end;
