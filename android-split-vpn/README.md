# Split Shield

App Android (Kotlin) que sobe o **seu túnel WireGuard** em primeiro plano, o dia todo, e permite
escolher quais apps ficam **fora** da VPN (split tunneling) para que eles não enxerguem a VPN.

> Projeto **não compilado nem testado em aparelho** por quem o gerou (o ambiente não tinha o SDK do
> Android). Ele foi escrito com APIs padrão, mas o primeiro build pode pedir pequenos ajustes de versão.

## O que faz

| Função | Como |
|---|---|
| Criptografia do tráfego | WireGuard oficial (`com.wireguard.android:tunnel`): ChaCha20-Poly1305 + Curve25519 |
| Config protegida | Chave privada e config ficam em `EncryptedSharedPreferences` (AES-256, Android Keystore) |
| Rodar o dia todo | Serviço em primeiro plano (`specialUse`) + `START_STICKY` + notificação com botão Desconectar |
| Reconectar após boot | Opção na tela inicial (só se a VPN estava ligada) |
| **Apps que não veem a VPN** | `ExcludedApplications` → `VpnService.Builder.addDisallowedApplication()`: o app excluído usa a rede normal |
| Alerta de vazamento | Avisa se a config não tem `DNS =` ou `::/0` em `AllowedIPs` (IPv6 vazando) |
| Teste de coerência | Mostra IP de saída, ASN, país do IP × SIM e fuso do IP × aparelho |
| Kill switch | Atalho para "VPN sempre ativa" do próprio Android |
| Bateria | Atalho para liberar o app da otimização de bateria |

## Limites (leia)

- **Apps que passam pela VPN continuam podendo detectá-la.** Nenhum app comum consegue ocultar a VPN de
  outros apps; isso exigiria root + hook (LSPosed), que este projeto **não** faz. Por isso a estratégia é:
  apps problemáticos ficam **fora** do túnel.
- Apps fora do túnel **não são protegidos** pela VPN (saem com o seu IP real).
- O ícone de chave/aviso de VPN na barra de status é do sistema e não dá para esconder.
- Detecção pelo **IP** (datacenter/lista de VPN) não depende do app. Use o botão "Testar IP" e prefira um IP
  residencial, do mesmo país do seu chip.
- Só suporta **WireGuard** (arquivo `.conf`). OpenVPN/V2Ray não.
- Com "Bloquear conexões sem VPN" ligado, teste se os apps excluídos ainda têm internet; em alguns Androids
  eles ficam bloqueados.

## Como abrir e rodar

1. Android Studio (Koala ou mais novo) → **Open** → escolha esta pasta → aguarde o Gradle sincronizar.
2. No S25 FE: Configurações → Sobre o telefone → toque 7× em "Número da versão" → Opções do desenvolvedor →
   **Depuração USB**. Conecte o cabo e clique em **Run ▶**.
3. Ou gere o APK: **Build → Build Bundle(s)/APK(s) → Build APK(s)** e instale `app/build/outputs/apk/`.

## Como usar

1. **Importar config WireGuard (.conf)** (ou colar o texto). Ideal ter `DNS =` e `AllowedIPs = 0.0.0.0/0, ::/0`.
2. **Apps fora da VPN**: marque os apps que te expulsam quando detectam VPN.
3. **Conectar** (aceite a permissão de VPN e de notificações).
4. **Liberar uso de bateria** e, se quiser, **Reconectar após reiniciar**.
5. **Kill switch**: abra o atalho, toque na engrenagem do Split Shield e ative "VPN sempre ativa".

## Estrutura

```
app/src/main/java/com/splitshield/
  MainActivity.kt          UI principal, importação, testes
  AppsActivity.kt          lista de apps para split tunneling
  VpnForegroundService.kt  serviço em primeiro plano + notificação
  VpnController.kt         sobe/derruba o túnel (GoBackend) e publica o estado
  ConfigPatcher.kt         injeta ExcludedApplications e analisa vazamentos (lógica pura, com teste)
  Store.kt                 armazenamento cifrado
  BootReceiver.kt          restaura a VPN após boot
```

Use somente com servidores WireGuard seus ou que você tem autorização para usar.
