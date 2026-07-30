/**
 * Store para manejar el progreso del relevamiento de una estación
 */

//Services
import { IndexedDBService } from '@/services/indexDB.js'
import { stairsService } from '@/services'

//Using others Stores
import { useStationStore, useImageStore, useSnackbarStore } from '@/stores'

export const useSurveyStore = defineStore('survey', () => {

  const stationStore = useStationStore()

  // Función helper: Convertir objeto reactivo a objeto plano (deep)
  function toPlainObject(obj) {
    return JSON.parse(JSON.stringify(toRaw(obj)))
  }

  // Estado reactivo
  const currentSurvey = ref(null) // Relevamiento en progreso
  const currentStairIndex = ref(0) // Índice de escalera actual (0-based)
  const currentStairs = ref([]) // Escaleras de la estación seleccionada
  const isSaving = ref(false)


  // Computed properties
  const isActive = computed(() => currentSurvey.value !== null)

  const total_stairs = computed(() =>
    currentSurvey.value?.total_stairs || 0
  )

  const completedStairs = computed(() =>
    currentSurvey.value?.stairs.filter(s => s.status === 'completed').length || 0
  )

  const pendingStairs = computed(() =>
    total_stairs.value - completedStairs.value
  )

  const currentStair = computed(() =>
    currentSurvey.value?.stairs[currentStairIndex.value] || null
  )

  const isLastStair = computed(() =>
    currentStairIndex.value === total_stairs.value - 1
  )

  const progress = computed(() =>
    total_stairs.value > 0 ? Math.round((completedStairs.value / total_stairs.value) * 100) : 0
  )

  // Estadísticas del relevamiento
  const stats = computed(() => {
    if (!currentSurvey.value) return { working: 0, notWorking: 0 }

    // const working = currentSurvey.value.stairs.filter(s =>
    //   s.status === 'completed' && s.is_working === true
    // ).length
    const working = currentStairs.value.filter(s =>
      s.status === 'completed' && s.is_working === true
    ).length

    const notWorking = currentStairs.value.filter(s =>
      s.status === 'completed' && s.is_working === false
    ).length

    return { working, notWorking }
  })

  /* Actions */
  // Iniciar nuevo relevamiento de estación
  function startSurvey(station) {
 
    currentStairs.value = stationStore.rawStairs.filter(
      s => s.station === station.id)


    const stairTemplates = currentStairs.value.map(s => {
      return {
        id: s.id,
        stair: s.id,
        number: s.number,
        stair_full: s,
        code_identifiers: [],
        without_codes: false,

        // Puntos de conexión
        route_start: '',
        path_start: '',
        path_end: '',
        route_end: '',

        // Estado de mantenimiento
        status_maintenance: null, // 'minor' | 'major' | 'critical' | 'other'
        direction_observed: null,
        other_status_maintenance: '',

        // Estado operativo
        is_working: null,

        details: '',
        photo_ids: [],
        image_urls: [],
        status: 'pending', // 'pending' | 'completed'

        // Sincronización con backend
        backend_id: null,
        synced: false, // ¿el reporte se guardó en el backend?
        synced_at: null,
        images_synced: false // ¿las imágenes están confirmadas en el backend?
      }
    })
    currentStairs.value = stairTemplates

    currentSurvey.value = {
      // Datos de la estación
      station_id: station.station_id,
      station_name: station.name,
      line: station.line,
      line_color: station.line_color,
      total_stairs: station.total_stairs,

      // Array de escaleras
      stairs: stairTemplates,

      // Estadísticas
      completedStairs: 0,
      stairsWorking: 0,
      stairsNotWorking: 0,

      // Metadata
      surveyStartedAt: Date.now(),
      surveyCompletedAt: null,
      status: 'in_progress'
    }

    currentStairIndex.value = 0
  }

  /**
   * Sube las imágenes de una escalera a su reporte YA guardado (stair.backend_id).
   * NO crea el reporte: solo adjunta imágenes. Actualiza stair.images_synced.
   * @param {Object} stair - Escalera con backend_id ya asignado
   * @param {Array<File>} images - Imágenes a subir (opcional)
   * @returns {Promise<boolean>} - true si no había nada que subir o si subió bien
   */
  async function uploadImagesForStair(stair, images = []) {
    // Sin imágenes: no hay nada pendiente
    if (!images || images.length === 0) {
      stair.images_synced = true
      return true
    }

    // Sin id de reporte no se pueden adjuntar (no debería pasar si synced === true)
    if (!stair.backend_id) {
      console.warn(`⚠️ Escalera ${stair.number} sin backend_id: no se pueden subir imágenes`)
      stair.images_synced = false
      return false
    }

    try {
      console.log(`📤 Subiendo ${images.length} imágenes para escalera ${stair.number}...`)
      const imageResponse = await stairsService.uploadStairImages(stair.backend_id, images)

      // Guardar referencias de imágenes
      stair.photo_ids = imageResponse.photo_ids || []
      stair.image_urls = imageResponse.image_urls || []
      stair.images_synced = true

      console.log(`✅ Imágenes subidas para escalera ${stair.number}`)
      return true
    } catch (imageError) {
      // Las imágenes NO se pierden: images_synced queda en false y quedan
      // persistidas en IndexedDB para reintentarse (ver syncPendingStairs).
      console.warn(`⚠️ Error subiendo imágenes de escalera ${stair.number}:`, imageError.message)
      stair.images_synced = false
      return false
    }
  }

  /**
   * ----------Sincronzar escalera por escalera.-------
   * Guarda el reporte y (si hay) sube las imágenes. El reporte y las imágenes
   * se sincronizan por separado: si el reporte se guarda pero las imágenes fallan,
   * la escalera queda synced=true / images_synced=false (pendiente de imágenes).
   * @param {Object} stair - Objeto de escalera con todos sus datos
   * @param {Array<File>} images - Array de imágenes (opcional)
   * @returns {Promise<Object>} - { success, reportId, imagesPending, error? }
   */
  async function syncSingleStair(stair, images = []) {
    try {
      // Preparar datos del reporte para api/stair_report/
      const reportData = {
        stair: stair.stair, // ID de la escalera del catálogo
        status_maintenance: stair.status_maintenance || null,
        direction_observed: stair.direction_observed || null,
        other_status_maintenance: stair.other_status_maintenance || '',
        code_identifiers: stair.code_identifiers || [],
        route_start: stair.route_start || '',
        path_start: stair.path_start || '',
        path_end: stair.path_end || '',
        route_end: stair.route_end || '',
        // Si es estado crítico y is_working es null, asumimos false (no funciona)
        is_working: stair.is_working,
        details: stair.details || ''
      }

      console.log(`📤 Guardando escalera ${stair.number} (ID catálogo: ${stair.stair})...`)

      // 1. Guardar datos de la escalera
      const savedReport = await stairsService.saveStair(toPlainObject(reportData))

      console.log(`✅ Escalera ${stair.number} guardada con ID: ${savedReport.id}`)

      // 2. Marcar el REPORTE como sincronizado (aunque las imágenes fallen después)
      stair.backend_id = savedReport.id
      stair.synced = true
      stair.synced_at = Date.now()

      // 3. Subir imágenes al reporte recién creado (no re-crea el reporte).
      //    Si fallan, images_synced queda en false y se reintentarán aparte.
      await uploadImagesForStair(stair, images)

      return {
        success: true,
        reportId: savedReport.id,
        // El reporte se guardó; avisamos si las imágenes quedaron pendientes
        imagesPending: images && images.length > 0 && stair.images_synced === false
      }

    } catch (error) {
      console.error(`❌ Error sincronizando escalera ${stair.number}:`, error.message)
      stair.synced = false

      return {
        success: false,
        error: error.message
      }
    }
  }

  // Completar relevamiento y guardar (con sincronización al backend si hay conexión)
  async function completeSurvey() {
    if (!currentSurvey.value) {
      throw new Error('No hay relevamiento activo')
    }

    const imageStore = useImageStore()
    const snackbarStore = useSnackbarStore()
    const isOnline = navigator.onLine

    try {
      isSaving.value = true

      console.log(`🔄 Guardando relevamiento (${isOnline ? 'online' : 'offline'})...`)
      console.log('📸 Estado del imageStore.modelPhoto:', imageStore.modelPhoto)

      let syncedCount = 0
      let failedCount = 0
      let imagesPendingCount = 0

      // Intentar sincronizar cada escalera con el backend (si hay conexión)
      if (isOnline) {
        for (let i = 0; i < currentStairs.value.length; i++) {
          const stair = currentStairs.value[i]
          const photos = imageStore.getStairPhotos(stair.id) // ✅ Usar stair.id en lugar de índice

          console.log(`📸 Escalera ${stair.number} (ID: ${stair.id}): ${photos?.length || 0} foto(s) encontrada(s)`)

          // Sincronizar escalera opr escalera.
          const result = await syncSingleStair(stair, photos)

          if (result.success) {
            syncedCount++
            if (result.imagesPending) imagesPendingCount++
          } else {
            failedCount++
          }
        }

        // Mostrar resultado de sincronización
        if (syncedCount > 0) {
          snackbarStore.showSuccess(`${syncedCount} escalera(s) sincronizada(s) con el servidor`)
        }
        if (failedCount > 0) {
          snackbarStore.showWarning(`${failedCount} escalera(s) quedaron pendientes de sincronización`)
        }
        // Aviso explícito: reporte guardado pero imágenes NO subidas (antes fallaba en silencio)
        if (imagesPendingCount > 0) {
          snackbarStore.showWarning(`${imagesPendingCount} escalera(s) se guardaron, pero sus imágenes no se pudieron subir. Se reintentarán al sincronizar.`)
        }
      } else {
        console.log('📴 Sin conexión - guardando solo en local')
        snackbarStore.showInfo('Guardado en local (se sincronizará cuando haya conexión)')
      }

      // Actualizar estadísticas finales
      currentSurvey.value.completedStairs = completedStairs.value
      currentSurvey.value.stairsWorking = stats.value.working
      currentSurvey.value.stairsNotWorking = stats.value.notWorking
      currentSurvey.value.surveyCompletedAt = Date.now()
      currentSurvey.value.status = 'completed'

      // Convertir a objeto plano (sin reactividad) antes de guardar
      const plainSurvey = toPlainObject(currentSurvey.value)

      // SIEMPRE guardar en IndexedDB (backup local)
      const savedRecord = await IndexedDBService.saveStationRecord(plainSurvey)

      console.log('✅ Relevamiento completado y guardado localmente:', savedRecord.id)

      return savedRecord

    } catch (error) {
      console.error('❌ Error completando relevamiento:', error)
      snackbarStore.showError(`Error al guardar: ${error.message}`)
      throw error
    } finally {
      isSaving.value = false
    }
  }

  // Cancelar relevamiento actual
  function cancelSurvey() {
    currentSurvey.value = null
    currentStairIndex.value = 0
    console.log('❌ Relevamiento cancelado')
  }

  /**
   * Re-sincronizar escaleras pendientes
   * Busca en IndexedDB todas las escaleras con synced: false y las envía al servidor
   */
  async function syncPendingStairs() {
    const imageStore = useImageStore()
    const snackbarStore = useSnackbarStore()

    if (!navigator.onLine) {
      console.log('📴 Sin conexión - no se puede sincronizar')
      snackbarStore.showWarning('Sin conexión a internet')
      return { synced: 0, failed: 0, total: 0 }
    }

    try {
      console.log('🔄 Buscando escaleras pendientes de sincronización...')

      // Obtener todos los registros de estaciones desde IndexedDB
      const allRecords = await IndexedDBService.getAllStationRecords()

      if (!allRecords || allRecords.length === 0) {
        console.log('✅ No hay registros guardados')
        return { synced: 0, failed: 0, total: 0 }
      }

      // Buscar escaleras no sincronizadas en todos los registros
      const pendingStairs = []
      allRecords.forEach(record => {
        if (record.stairs && Array.isArray(record.stairs)) {
          record.stairs.forEach((stair, index) => {
            const reportPending = !stair.synced
            // Reporte ya guardado pero imágenes sin subir. Se compara === false
            // para NO marcar registros viejos (sin el campo, undefined) como pendientes.
            const imagesPending = stair.synced === true && stair.images_synced === false
            if (reportPending || imagesPending) {
              pendingStairs.push({
                stair,
                stairIndex: index,
                recordId: record.id,
                station_id: record.station_id
              })
            }
          })
        }
      })

      if (pendingStairs.length === 0) {
        console.log('✅ No hay escaleras pendientes de sincronización')
        return { synced: 0, failed: 0, total: 0 }
      }

      console.log(`📊 Encontradas ${pendingStairs.length} escaleras pendientes`)

      let syncedCount = 0
      let failedCount = 0

      // Sincronizar cada escalera usando la función modular
      for (const { stair, stairIndex, recordId } of pendingStairs) {
        // Obtener imágenes de IndexedDB para esta escalera
        const imageRecords = await IndexedDBService.getStairImages(recordId, stair.number)
        const imageFiles = imageRecords.map(img => img.file) // Extraer File objects

        console.log(`📸 ${imageFiles.length} imágenes encontradas para escalera ${stair.number} (record ${recordId})`)

        // Si el reporte YA existe (solo faltan imágenes), subir SOLO imágenes al
        // backend_id existente para no duplicar el reporte. Si no, crear reporte + imágenes.
        let success
        if (stair.synced && stair.backend_id) {
          // Anomalía: marcada como imágenes pendientes pero sin archivos locales.
          // NO la marcamos como sincronizada, para no ocultar el fallo como "éxito".
          if (imageFiles.length === 0) {
            console.warn(`⚠️ Escalera ${stair.number}: pendiente de imágenes pero sin archivos en IndexedDB`)
            failedCount++
            continue
          }
          success = await uploadImagesForStair(stair, imageFiles)
        } else {
          const result = await syncSingleStair(stair, imageFiles)
          success = result.success
        }

        // Persistir SIEMPRE el estado actualizado de la escalera (synced, backend_id,
        // images_synced) para que un fallo parcial no reintente desde cero.
        const record = allRecords.find(r => r.id === recordId)
        if (record) {
          await IndexedDBService.updateStationRecord(recordId, { stairs: record.stairs })
        }

        // Borrar imágenes locales solo cuando YA están confirmadas en el backend
        if (success && stair.images_synced === true) {
          if (imageFiles.length > 0) {
            await IndexedDBService.deleteStairImages(recordId, stair.number)
            console.log(`🗑️ Imágenes eliminadas de IndexedDB para escalera ${stair.number}`)
          }
          syncedCount++
        } else {
          failedCount++
        }
      }

      const result = {
        synced: syncedCount,
        failed: failedCount,
        total: pendingStairs.length
      }

      // Mostrar resultado al usuario
      if (syncedCount > 0) {
        snackbarStore.showSuccess(`${syncedCount} escalera(s) sincronizada(s)`)
      }
      if (failedCount > 0) {
        snackbarStore.showWarning(`${failedCount} escalera(s) no se pudieron sincronizar`)
      }

      console.log(`✅ Re-sincronización completa:`, result)
      return result

    } catch (error) {
      console.error('❌ Error durante re-sincronización:', error)
      snackbarStore.showError(`Error en sincronización: ${error.message}`)
      throw error
    }
  }

  /**
   * Obtener estadísticas de sincronización
   * Cuenta cuántas escaleras están pendientes de sincronizar
   */
  async function getSyncStats() {
    try {
      const allRecords = await IndexedDBService.getAllStationRecords()

      let totalStairs = 0
      let syncedStairs = 0
      let pendingStairs = 0

      allRecords.forEach(record => {
        if (record.stairs && Array.isArray(record.stairs)) {
          record.stairs.forEach(stair => {
            totalStairs++
            // Pendiente si falta el reporte O si el reporte está pero las imágenes no
            const imagesPending = stair.synced === true && stair.images_synced === false
            if (stair.synced && !imagesPending) {
              syncedStairs++
            } else {
              pendingStairs++
            }
          })
        }
      })

      return {
        total: totalStairs,
        synced: syncedStairs,
        pending: pendingStairs
      }
    } catch (error) {
      console.error('Error obteniendo stats de sincronización:', error)
      return { total: 0, synced: 0, pending: 0 }
    }
  }

  return {
    // Estado
    currentSurvey,
    currentStairIndex,
    isSaving,
    currentStairs,

    // Computed
    isActive,
    total_stairs,
    completedStairs,
    pendingStairs,
    currentStair,
    isLastStair,
    progress,
    stats,

    // Acciones
    startSurvey,
    completeSurvey,
    cancelSurvey,
    syncPendingStairs,
    getSyncStats
  }
})
